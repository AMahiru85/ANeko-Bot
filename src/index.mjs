import http from "node:http";
import { config } from "./config.mjs";
import { ConversationStore } from "./memory.mjs";
import { LlmClient } from "./llm.mjs";
import { QQApi } from "./qq-api.mjs";
import { QQGateway } from "./qq-gateway.mjs";

const memory = new ConversationStore();
const llm = new LlmClient({
  apiKey: config.llmApiKey,
  baseUrl: config.llmBaseUrl,
  model: config.llmModel,
  systemPrompt: config.systemPrompt,
  provider: config.aiProvider,
});
const qqApi = new QQApi({
  appId: config.qqAppId,
  clientSecret: config.qqClientSecret,
  apiBase: config.qqApiBase,
  gatewayUrl: config.qqGatewayUrl,
});

const userQueues = new Map();
const processedMessages = new Map();
const PROCESSED_MESSAGE_TTL = 10 * 60 * 1_000;
const STREAM_UPDATE_INTERVAL_MS = 100;
const STREAM_CONTENT_LIMIT = 2_000;
const INTERACTION_INTENT = 1 << 26;
const EFFORT_VALUES = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const EFFORT_LABELS = {
  none: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "最高",
};
const DEEPSEEK_TOOLS = [
  {
    type: "function",
    function: {
      name: "search_web",
      description: "Search the live web when the user asks for current information or sources.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The web search query." },
          count: { type: "integer", minimum: 1, maximum: 10, description: "Number of results." },
          need_content: { type: "boolean", description: "Whether to include page content." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fetch_web_page",
      description: "Fetch an HTTP or HTTPS page as Markdown after a relevant URL is known.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "The page URL." } },
        required: ["url"],
      },
    },
  },
];
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_MODEL_BUTTONS = 3;
const runtimeSettings = {
  model: config.llmModel,
  reasoningEffort: config.llmReasoningEffort,
};

function createSettingButton(id, label, data) {
  return {
    id,
    render_data: {
      label: label.slice(0, 10),
      style: 0,
    },
    action: {
      type: 1,
      permission: {
        type: 2,
        specify_user_ids: [],
        specify_role_ids: [],
      },
      data,
    },
  };
}

function rowsFromButtons(buttons, size = 4) {
  const rows = [];
  for (let i = 0; i < buttons.length; i += size) rows.push({ buttons: buttons.slice(i, i + size) });
  return rows;
}

function modelIds(payload) {
  const models = Array.isArray(payload?.data) ? payload.data : [];
  return [...new Set(models
    .map((model) => String(model?.id || "").trim())
    .filter((model) => MODEL_NAME_PATTERN.test(model)))]
    .slice(0, MAX_MODEL_BUTTONS);
}

function modelButtonLabel(model) {
  const compact = model.replace(/^deepseek[-_:]?/i, "");
  if (compact.length <= 10) return compact || model.slice(0, 10);
  return `${compact.slice(0, 7)}...`;
}

function settingsKeyboard({ models = [] } = {}) {
  const rows = [{
    buttons: [createSettingButton("settings-effort", "思考等级", "settings-command:effort")],
  }];
  if (config.aiProvider === "deepseek") {
    rows.push({
      buttons: [createSettingButton("deepseek-select-model", "选择模型", "deepseek-command:/models")],
    });
    if (models.length) {
      rows.push(...rowsFromButtons(models.map((model, index) => createSettingButton(
        `deepseek-model-${index}`,
        modelButtonLabel(model),
        `model:${model}`,
      )), 3));
    }
    rows.push({
      buttons: [createSettingButton("deepseek-balance", "查询余额", "deepseek-command:/balance")],
    });
  }
  return {
    content: {
      rows,
    },
  };
}

function effortSelectionKeyboard() {
  return {
    content: {
      rows: rowsFromButtons([...EFFORT_VALUES].map((effort) => createSettingButton(
        `effort-${effort}`,
        EFFORT_LABELS[effort],
        `effort:${effort}`,
      )), 3),
    },
  };
}

function modelSelectionKeyboard(models) {
  return {
    content: {
      rows: rowsFromButtons(models.map((model, index) => createSettingButton(
        `deepseek-model-${index}`,
        modelButtonLabel(model),
        `model:${model}`,
      )), 3),
    },
  };
}

function settingsMarkdown(prefix = "") {
  const heading = prefix ? `${prefix}\n\n` : "";
  const effortLabel = EFFORT_LABELS[runtimeSettings.reasoningEffort] || runtimeSettings.reasoningEffort;
  const sections = [
    "# LLM 设置",
    "",
    "## 模型参数",
    `当前思考等级：**${effortLabel}**`,
    `当前模型：**${runtimeSettings.model}**`,
  ];
  return `${heading}${sections.join("\n")}`;
}

async function sendSettingsMenu(userId, options = {}) {
  return qqApi.sendC2CMarkdown(userId, settingsMarkdown(options.prefix), settingsKeyboard(options), options);
}

async function sendModelSelectionMenu(userId, models) {
  return qqApi.sendC2CMarkdown(userId, "请选择模型：", modelSelectionKeyboard(models));
}

async function sendEffortSelectionMenu(userId) {
  return qqApi.sendC2CMarkdown(userId, "请选择思考等级：", effortSelectionKeyboard());
}

async function handleInteraction(data) {
  if (data?.type !== 11 || data.scene !== "c2c") return;

  const interactionId = data.id;
  const userId = data.user_openid;
  if (!interactionId || !userId || wasProcessed(interactionId)) return;

  await qqApi.respondInteraction(interactionId).catch((error) => {
    console.error("[QQ] failed to acknowledge interaction:", error);
  });
  markProcessed(interactionId);

  const buttonData = data.data?.resolved?.button_data || data.data?.button_data || "";
  const callbackMessageId = data.message?.id || data.message_id || data.msg_id;
  return enqueue(userId, async () => {
    let prefix = "按钮操作未识别，请重新打开设置菜单。";
    let callbackMessage = prefix;
    let models = [];
    let modelSelectionOnly = false;
    let effortSelectionOnly = false;
    if (config.aiProvider === "deepseek" && buttonData.startsWith("model:")) {
      const model = buttonData.slice("model:".length).trim();
      if (MODEL_NAME_PATTERN.test(model)) {
        runtimeSettings.model = model;
        prefix = `已切换当前模型：**${model}**`;
        callbackMessage = `当前模型：${model}`;
      } else {
        prefix = "模型选项已失效，请重新打开设置菜单。";
        callbackMessage = prefix;
      }
    }

    if (buttonData === "settings-command:effort") {
      effortSelectionOnly = true;
      callbackMessage = "";
    }

    if (buttonData.startsWith("effort:")) {
      const effort = buttonData.slice("effort:".length).toLowerCase();
      if (EFFORT_VALUES.has(effort)) {
        runtimeSettings.reasoningEffort = effort;
        prefix = `已设置全局思考等级：**${EFFORT_LABELS[effort]}**`;
        callbackMessage = `当前思考等级：${EFFORT_LABELS[effort]}`;
      }
    }

    if (config.aiProvider === "deepseek" && buttonData.startsWith("deepseek-command:")) {
      const command = buttonData.slice("deepseek-command:".length);
      try {
        if (command === "hint-search") {
          prefix = "请发送 `/search 关键词` 执行网页搜索。";
          callbackMessage = prefix;
        } else if (command === "hint-fetch") {
          prefix = "请发送 `/fetch https://...` 抓取网页。";
          callbackMessage = prefix;
        } else if (command === "/models") {
          const payload = await llm.listModels();
          models = modelIds(payload);
          modelSelectionOnly = models.length > 0;
          prefix = modelSelectionOnly ? "" : "DeepSeek 当前没有返回可用模型。";
          callbackMessage = "";
        } else {
          const result = await executeDeepSeekCommand(command);
          prefix = result ? result.slice(0, 900) : "命令未识别，请重新打开设置菜单。";
          callbackMessage = prefix;
        }
      } catch (error) {
        prefix = `操作失败：${error.message}`.slice(0, 900);
        callbackMessage = prefix;
      }
    }

    if (callbackMessage) {
      await qqApi.sendC2CMessage(userId, callbackMessage, callbackMessageId).catch((error) => {
        console.error("[C2C] failed to send settings status:", error);
      });
    }
    if (modelSelectionOnly) {
      await sendModelSelectionMenu(userId, models).catch((error) => {
        console.error("[C2C] failed to send model selection menu:", error);
      });
      return;
    }

    if (effortSelectionOnly) {
      await sendEffortSelectionMenu(userId).catch((error) => {
        console.error("[C2C] failed to send effort selection menu:", error);
      });
      return;
    }

    const menuRefreshRequired = !buttonData.startsWith("effort:")
      && buttonData !== "deepseek-command:/balance"
      && buttonData !== "settings-command:effort";
    if (!menuRefreshRequired) return;

    await sendSettingsMenu(userId, { prefix, models }).catch((error) => {
      console.error("[C2C] failed to send settings menu:", error);
    });
  });
}

function wasProcessed(messageId) {
  const timestamp = processedMessages.get(messageId);
  if (!timestamp) return false;
  if (Date.now() - timestamp > PROCESSED_MESSAGE_TTL) {
    processedMessages.delete(messageId);
    return false;
  }
  return true;
}

function markProcessed(messageId) {
  const now = Date.now();
  processedMessages.set(messageId, now);
  if (processedMessages.size < 10_000) return;

  for (const [id, timestamp] of processedMessages) {
    if (now - timestamp > PROCESSED_MESSAGE_TTL) processedMessages.delete(id);
  }
  while (processedMessages.size > 10_000) {
    processedMessages.delete(processedMessages.keys().next().value);
  }
}

function enqueue(userId, task) {
  const previous = userQueues.get(userId) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  userQueues.set(userId, current);
  void current.finally(() => {
    if (userQueues.get(userId) === current) userQueues.delete(userId);
  }).catch(() => {});
  return current;
}

function messageAttachments(data) {
  const attachments = [
    ...(Array.isArray(data?.attachments) ? data.attachments : []),
    ...(Array.isArray(data?.message?.attachments) ? data.message.attachments : []),
  ];
  return attachments.filter((attachment) => {
    const type = String(attachment?.content_type || attachment?.contentType || "").toLowerCase();
    return type.startsWith("image/") || /\.(?:png|jpe?g|gif|webp)(?:$|\?)/i.test(String(attachment?.url || ""));
  });
}

function buildUserMessage(text, attachments) {
  if (config.aiProvider !== "deepseek" || attachments.length === 0) {
    return { role: "user", content: text };
  }
  const blocks = [];
  if (text) blocks.push({ type: "text", text });
  if (!text) blocks.push({ type: "text", text: "请分析这张图片。" });
  for (const attachment of attachments) {
    const url = attachment.url || attachment.href;
    if (url) blocks.push({ type: "image_url", image_url: { url } });
  }
  return { role: "user", content: blocks };
}

function formatModels(payload) {
  const models = Array.isArray(payload?.data) ? payload.data : [];
  if (!models.length) return "DeepSeek 当前没有返回可用模型。";
  return ["DeepSeek 模型列表：", ...models.map((model) => {
    const modalities = Array.isArray(model.input_modalities) ? model.input_modalities.join("/") : "text";
    return `- ${model.id || "unknown"}${model.name ? `（${model.name}）` : ""}，输入：${modalities}`;
  })].join("\n").slice(0, STREAM_CONTENT_LIMIT);
}

function formatBalance(payload) {
  const entries = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
  if (!entries.length) return `DeepSeek 余额状态：${payload?.is_available ? "可用" : "不可用"}`;
  return ["DeepSeek 余额：", ...entries.map((entry) =>
    `- ${entry.currency || "未知币种"}：${entry.total_balance ?? "未知"}（赠金 ${entry.granted_balance ?? "未知"}，充值 ${entry.topped_up_balance ?? "未知"}）`,
  )].join("\n");
}

function formatSearch(payload) {
  const results = Array.isArray(payload?.results) ? payload.results : [];
  if (!results.length) return "没有找到相关网页。";
  return ["搜索结果：", ...results.slice(0, 8).map((result, index) =>
    `${index + 1}. ${result.title || result.url}\n${result.url}\n${result.snippet || result.summary || ""}`,
  )].join("\n\n").slice(0, STREAM_CONTENT_LIMIT);
}

function formatFiles(payload) {
  const files = Array.isArray(payload?.data) ? payload.data : [];
  if (!files.length) return "DeepSeek 文件列表为空。";
  return ["DeepSeek 文件：", ...files.map((file) =>
    `- ${file.id || "unknown"} ${file.filename || "未命名"}（${file.bytes ?? "?"} bytes）`,
  )].join("\n").slice(0, STREAM_CONTENT_LIMIT);
}

async function executeDeepSeekCommand(text) {
  if (config.aiProvider !== "deepseek") return null;
  if (/^\/models$/i.test(text)) {
    return formatModels(await llm.listModels());
  }
  if (/^\/balance$/i.test(text)) {
    return formatBalance(await llm.getBalance());
  }
  if (/^\/files$/i.test(text)) {
    return formatFiles(await llm.listFiles());
  }
  const search = text.match(/^(?:\/search|搜索|网页搜索)\s+(.+)$/i);
  if (search) {
    return formatSearch(await llm.webSearch(search[1], { parameters: { need_content: true } }));
  }
  const fetchMatch = text.match(/^(?:\/fetch|抓取|网页抓取)\s+(https?:\/\/\S+)$/i);
  if (fetchMatch) {
    const page = await llm.fetchWebPage(fetchMatch[1]);
    return `${page.title || fetchMatch[1]}\n\n${page.content || "页面没有可提取内容。"}`.slice(0, STREAM_CONTENT_LIMIT);
  }
  return null;
}

async function runDeepSeekTool(name, args = {}) {
  if (name === "search_web") {
    if (typeof args.query !== "string" || !args.query.trim()) throw new Error("搜索关键词不能为空");
    return llm.webSearch(args.query.trim(), {
      parameters: {
        ...(Number.isInteger(args.count) ? { count: args.count } : {}),
        ...(typeof args.need_content === "boolean" ? { need_content: args.need_content } : {}),
      },
    });
  }
  if (name === "fetch_web_page") {
    if (typeof args.url !== "string" || !/^https?:\/\/\S+$/i.test(args.url)) {
      throw new Error("网页地址必须是 HTTP 或 HTTPS URL");
    }
    return llm.fetchWebPage(args.url);
  }
  throw new Error(`未知 DeepSeek 工具：${name}`);
}

async function handleDeepSeekCommand(userId, messageId, text) {
  const result = await executeDeepSeekCommand(text);
  if (!result) return false;
  await qqApi.sendC2CMessage(userId, result, messageId);
  return true;
}

async function streamC2CReply(userId, messageId, history) {
  let answer = "";
  let streamMsgId = "";
  let sentAnswer = "";
  let lastSentAt = 0;
  let index = 0;

  try {
    const responseStream = config.aiProvider === "deepseek"
      ? llm.streamWithTools(history, {
        ...runtimeSettings,
        tools: DEEPSEEK_TOOLS,
        toolHandler: runDeepSeekTool,
      })
      : llm.stream(history, runtimeSettings);
    for await (const delta of responseStream) {
      answer += delta;
      const content = answer.slice(0, STREAM_CONTENT_LIMIT);
      const shouldSend = content.trim() && content !== sentAnswer && (
        !streamMsgId || Date.now() - lastSentAt >= STREAM_UPDATE_INTERVAL_MS
      );
      if (shouldSend) {
        const reply = await qqApi.sendC2CStreamMessage(userId, content, messageId, streamMsgId, 1, index);
        streamMsgId = reply.streamMsgId;
        if (!streamMsgId) throw new Error("QQ stream reply did not return stream message id");
        sentAnswer = content;
        index += 1;
        lastSentAt = Date.now();
      }
    }

    if (!streamMsgId || !answer.trim()) throw new Error("LLM returned an empty response");
    await qqApi.sendC2CStreamMessage(
      userId,
      answer.slice(0, STREAM_CONTENT_LIMIT),
      messageId,
      streamMsgId,
      10,
      index,
    );
    return answer.trim();
  } catch (error) {
    if (streamMsgId) {
      error.streamStarted = true;
      const interrupted = `${answer.slice(0, STREAM_CONTENT_LIMIT)}\n\n（生成中断，请稍后重试）`.slice(0, STREAM_CONTENT_LIMIT);
      await qqApi.sendC2CStreamMessage(userId, interrupted, messageId, streamMsgId, 10, index)
        .catch((replyError) => console.error("[C2C] failed to finalize stream reply:", replyError));
    }
    throw error;
  }
}

async function handleEvent(type, data) {
  if (type === "INTERACTION_CREATE") return handleInteraction(data);
  if (type !== "C2C_MESSAGE_CREATE") return;

  const userId = data?.author?.user_openid;
  const messageId = data?.id;
  const text = typeof data?.content === "string" ? data.content.trim() : "";
  const attachments = messageAttachments(data);
  if (!userId || !messageId || (!text && !attachments.length)) return;
  if (wasProcessed(messageId)) return;

  return enqueue(userId, async () => {
    if (wasProcessed(messageId)) return;

    if (/^\/reset$/i.test(text)) {
      memory.clear(userId);
      await qqApi.sendC2CMessage(userId, "已清空当前上下文", messageId);
      markProcessed(messageId);
      return;
    }

    if (/^\/settings$/i.test(text)) {
      await sendSettingsMenu(userId, { msgId: messageId });
      markProcessed(messageId);
      return;
    }

    try {
      if (await handleDeepSeekCommand(userId, messageId, text)) {
        markProcessed(messageId);
        return;
      }
    } catch (error) {
      console.error(`[C2C] DeepSeek command failed for ${userId}:`, error);
      await qqApi.sendC2CMessage(userId, `操作失败：${error.message}`.slice(0, STREAM_CONTENT_LIMIT), messageId)
        .catch((replyError) => console.error("[C2C] failed to send command error:", replyError));
      markProcessed(messageId);
      return;
    }

    const userMessage = buildUserMessage(text, attachments);
    memory.append(userId, userMessage);

    try {
      const answer = await streamC2CReply(userId, messageId, memory.get(userId));
      memory.append(userId, { role: "assistant", content: answer });
      markProcessed(messageId);
      console.log(`[C2C] ${userId}: ${text.slice(0, 80)} -> ${answer.slice(0, 80)}`);
    } catch (error) {
      memory.removeLast(userId, userMessage);
      console.error(`[C2C] failed for ${userId}:`, error);
      if (!error.streamStarted) {
        await qqApi.sendC2CMessage(userId, "服务暂时繁忙，请稍后再试。", messageId).catch((replyError) => {
          console.error("[C2C] failed to send error reply:", replyError);
        });
      }
      markProcessed(messageId);
    }
  });
}

const server = http.createServer((request, response) => {
  if (request.url === "/health" && request.method === "GET") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, service: "qq-llm-agent" }));
    return;
  }
  response.writeHead(404);
  response.end("Not Found");
});

server.listen(config.httpPort, "127.0.0.1", () => {
  console.log(`[HTTP] health check: http://127.0.0.1:${config.httpPort}/health`);
});

const gateway = new QQGateway({
  api: qqApi,
  intents: config.qqIntents | INTERACTION_INTENT,
  onEvent: handleEvent,
  onError: (error) => console.error("[QQ]", error),
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  console.log("Shutting down...");
  gateway.stop();
  server.close(() => process.exit(0));
}

void gateway.start();
