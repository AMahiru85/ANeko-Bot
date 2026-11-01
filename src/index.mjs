import http from "node:http";
import { config } from "./config.mjs";
import { ConversationStore } from "./memory.mjs";
import { LlmClient } from "./llm.mjs";
import { QQApi } from "./qq-api.mjs";
import { QQGateway } from "./qq-gateway.mjs";

const memory = new ConversationStore({ maxMessages: config.maxContextMessages });
const llmClients = new Map(Object.values(config.providers).map((provider) => [provider.id, new LlmClient({
  apiKey: provider.apiKey,
  baseUrl: provider.baseUrl,
  model: provider.defaultModel,
  systemPrompt: config.systemPrompt,
  provider: provider.id,
  capabilities: provider.capabilities,
  apiStyle: provider.apiStyle || "chat",
})]));
let activeProvider = config.aiProvider;
let llm = llmClients.get(activeProvider);
if (!llm) throw new Error(`No LLM client configured for ${activeProvider}`);
const qqApi = new QQApi({
  appId: config.qqAppId,
  clientSecret: config.qqAppSecret,
  authBase: config.qqAuthBase,
  apiBase: config.qqApiBase,
  gatewayUrl: config.qqGatewayUrl,
});

const userQueues = new Map();
const processedMessages = new Map();
const PROCESSED_MESSAGE_TTL = 10 * 60 * 1_000;
const STREAM_UPDATE_INTERVAL_MS = Math.max(250, config.streamUpdateIntervalMs);
const STREAM_CONTENT_LIMIT = 1_800;
const INTERACTION_INTENT = 1 << 26;
const EFFORT_VALUES = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const EFFORT_LABELS = {
  none: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "最高",
  max: "极高",
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
const MAX_MODEL_BUTTONS = 9;
const runtimeSettings = {
  provider: activeProvider,
  model: config.llmModel,
  reasoningEffort: config.llmReasoningEffort,
};
const modelMetadata = new Map();

function activeProviderConfig() {
  return config.providers[activeProvider];
}

function activeCapabilities() {
  const base = activeProviderConfig()?.capabilities || {};
  const metadata = modelMetadata.get(runtimeSettings.model);
  if (!metadata) return base;
  const modalities = Array.isArray(metadata.input_modalities) ? metadata.input_modalities.map((item) => String(item).toLowerCase()) : [];
  return {
    ...base,
    vision: modalities.length ? modalities.some((item) => item.includes("image")) : base.vision,
    reasoning: metadata.effort?.supported_levels ? metadata.effort.supported_levels.length > 0 : base.reasoning,
  };
}

function switchProvider(providerId) {
  const provider = config.providers[providerId];
  const client = llmClients.get(providerId);
  if (!provider || !client) return false;
  activeProvider = providerId;
  llm = client;
  runtimeSettings.provider = providerId;
  runtimeSettings.model = provider.defaultModel;
  modelMetadata.clear();
  return true;
}

function createSettingButton(id, label, data) {
  return {
    id,
    render_data: {
      label: label.slice(0, 10),
      style: 0,
    },
    action: {
      // 官方内联键盘回调按钮使用 type=1；type=2 是指令按钮，不会触发 INTERACTION_CREATE。
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
  const provider = activeProviderConfig();
  const capabilities = activeCapabilities();
  const rows = [{
    buttons: [createSettingButton("settings-effort", "思考等级", "settings-command:effort")],
  }];
  const providerIds = Object.keys(config.providers);
  if (providerIds.length > 1) {
    rows.push(...rowsFromButtons(providerIds.slice(0, 5).map((id) => createSettingButton(
      `provider-${id}`,
      config.providers[id].name.slice(0, 10),
      `provider:${id}`,
    )), 5));
  }
  if (provider?.capabilities?.modelList || provider?.models?.length) {
    rows.push({
      buttons: [createSettingButton("select-model", "选择模型", "provider-command:/models")],
    });
  }
  if (capabilities.balance) {
    rows.push({ buttons: [createSettingButton("provider-balance", "查询余额", "provider-command:/balance")] });
  }
  const capabilityButtons = [];
  if (capabilities.files) capabilityButtons.push(createSettingButton("provider-files", "文件管理", "provider-command:/files"));
  if (capabilities.vision) capabilityButtons.push(createSettingButton("provider-vision", "图像理解", "provider-command:vision"));
  if (capabilities.webSearch && config.webSearchEnabled) capabilityButtons.push(createSettingButton("provider-web", "网页工具", "provider-command:web"));
  if (capabilityButtons.length) rows.push(...rowsFromButtons(capabilityButtons, 4));
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
  const provider = activeProviderConfig();
  const capabilities = activeCapabilities();
  const capabilityLabels = [
    ["vision", "图像"], ["tools", "工具"], ["files", "文件"], ["webSearch", "网页"], ["balance", "余额"],
  ].filter(([key]) => capabilities?.[key]).map(([, label]) => label).join("、") || "基础对话";
  const sections = [
    "# LLM 设置",
    "",
    "## 模型参数",
    `当前服务商：**${provider?.name || activeProvider}**`,
    `当前思考等级：**${effortLabel}**`,
    `当前模型：**${runtimeSettings.model}**`,
    `已启用能力：**${capabilityLabels}**`,
  ];
  return `${heading}${sections.join("\n")}`;
}

async function sendSettingsMenu(userId, options = {}) {
  if (typeof userId === "object") {
    const target = userId;
    if (target.kind === "c2c") {
      try {
        return await qqApi.sendC2CMarkdown(target.id, settingsMarkdown(options.prefix), settingsKeyboard(options), { msgId: target.messageId });
      } catch (error) {
        console.warn(`[QQ] Markdown keyboard unavailable, falling back to text settings: ${error.message}`);
        return qqApi.sendC2CMessage(target.id, `${settingsMarkdown(options.prefix)}\n\n可用命令：/provider 服务商ID、/model 模型名、/think 等级`, target.messageId);
      }
    }
    return sendTargetMessage(target, `${settingsMarkdown(options.prefix)}\n\n发送 /settings 可再次打开，发送 /reset 清空上下文。`);
  }
  try {
    return await qqApi.sendC2CMarkdown(userId, settingsMarkdown(options.prefix), settingsKeyboard(options), options);
  } catch (error) {
    console.warn(`[QQ] Markdown keyboard unavailable, falling back to text settings: ${error.message}`);
    return qqApi.sendC2CMessage(userId, `${settingsMarkdown(options.prefix)}\n\n可用命令：/provider 服务商ID、/model 模型名、/think 等级`, options.msgId);
  }
}

async function sendModelSelectionMenu(userId, models) {
  try {
    return await qqApi.sendC2CMarkdown(userId, "请选择模型：", modelSelectionKeyboard(models));
  } catch {
    return qqApi.sendC2CMessage(userId, `请选择模型：\n${models.map((model, index) => `${index + 1}. ${model}`).join("\n")}`);
  }
}

async function sendEffortSelectionMenu(userId) {
  try {
    return await qqApi.sendC2CMarkdown(userId, "请选择思考等级：", effortSelectionKeyboard());
  } catch {
    return qqApi.sendC2CMessage(userId, `请选择思考等级：${[...EFFORT_VALUES].join("、")}`);
  }
}

function eventTarget(type, data) {
  if (type === "C2C_MESSAGE_CREATE") {
    const id = data?.author?.user_openid || data?.author?.id;
    return id ? { kind: "c2c", id, messageId: data?.id } : null;
  }
  if (type === "GROUP_AT_MESSAGE_CREATE" || type === "GROUP_MESSAGE_CREATE") {
    const id = data?.group_openid || data?.group_id;
    return id ? { kind: "group", id, messageId: data?.id } : null;
  }
  if (type === "AT_MESSAGE_CREATE" || type === "MESSAGE_CREATE") {
    const id = data?.channel_id;
    return id ? { kind: "channel", id, messageId: data?.id } : null;
  }
  if (type === "DIRECT_MESSAGE_CREATE") {
    const id = data?.guild_id;
    return id ? { kind: "direct", id, messageId: data?.id } : null;
  }
  return null;
}

async function sendTargetMessage(target, content, { msgSeq = 1, eventId } = {}) {
  const text = String(content || "");
  if (target.kind === "c2c") return qqApi.sendC2CMessage(target.id, text, target.messageId, msgSeq, eventId);
  if (target.kind === "group") return qqApi.sendGroupMessage(target.id, text, target.messageId, msgSeq, eventId);
  if (target.kind === "direct") return qqApi.sendDirectMessage(target.id, text, target.messageId);
  return qqApi.sendChannelMessage(target.id, text, target.messageId);
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
  return enqueue(userId, async () => {
    let prefix = "按钮操作未识别，请重新打开设置菜单。";
    let callbackMessage = prefix;
    let models = [];
    let modelSelectionOnly = false;
    let effortSelectionOnly = false;
    if (buttonData.startsWith("provider:")) {
      const providerId = buttonData.slice("provider:".length).trim().toLowerCase();
      if (switchProvider(providerId)) {
        prefix = `已切换服务商：**${activeProviderConfig().name}**`;
        callbackMessage = `当前服务商：${activeProviderConfig().name}`;
      } else {
        prefix = "服务商选项已失效，请重新打开设置菜单。";
        callbackMessage = prefix;
      }
    }

    if (buttonData.startsWith("model:")) {
      const model = buttonData.slice("model:".length).trim();
      if (MODEL_NAME_PATTERN.test(model) && activeProviderConfig()?.models?.includes(model)) {
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

    if (buttonData.startsWith("provider-command:")) {
      const command = buttonData.slice("provider-command:".length);
      try {
        if (command === "/models") {
          if (!activeCapabilities().modelList) {
            models = activeProviderConfig()?.models || [];
          } else {
            const payload = await llm.listModels();
            models = modelIds(payload);
            if (models.length) {
              activeProviderConfig().models = models;
              for (const model of (Array.isArray(payload?.data) ? payload.data : [])) {
                if (model?.id && MODEL_NAME_PATTERN.test(String(model.id))) modelMetadata.set(String(model.id), model);
              }
            }
          }
          modelSelectionOnly = models.length > 0;
          prefix = modelSelectionOnly ? "" : `${activeProviderConfig()?.name || activeProvider} 当前没有返回可用模型。`;
          callbackMessage = "";
        } else if (command === "vision") {
          prefix = "请发送一张图片并附上问题，我会按当前模型的视觉能力分析。";
          callbackMessage = prefix;
        } else if (command === "web") {
          prefix = "可发送 `/search 关键词` 或 `/fetch https://...` 使用网页工具。";
          callbackMessage = prefix;
        } else {
          const result = await executeProviderCommand(command);
          prefix = result ? result.slice(0, 900) : "命令未识别，请重新打开设置菜单。";
          callbackMessage = prefix;
        }
      } catch (error) {
        prefix = `操作失败：${error.message}`.slice(0, 900);
        callbackMessage = prefix;
      }
    }

    if (callbackMessage) {
      await qqApi.sendC2CMessage(userId, callbackMessage, undefined, 1, interactionId).catch((error) => {
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
      && buttonData !== "provider-command:/balance"
      && buttonData !== "provider-command:/files"
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

async function buildUserMessage(text, attachments) {
  if (!activeCapabilities().vision || attachments.length === 0) {
    return { role: "user", content: text };
  }
  const blocks = [];
  if (text) blocks.push({ type: "text", text });
  if (!text) blocks.push({ type: "text", text: "请分析这张图片。" });
  for (const attachment of attachments) {
    const url = attachment.url || attachment.href;
    if (!url) continue;
    if (activeProvider === "deepseek" && activeCapabilities().files) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (response.ok) {
          const contentType = response.headers.get("content-type") || attachment.content_type || "image/jpeg";
          const file = await response.arrayBuffer();
          const uploaded = await llm.uploadFile(new Blob([file], { type: contentType }), "user_data", {
            filename: attachment.filename || `qq-image-${Date.now()}.jpg`,
          });
          if (uploaded?.id) {
            blocks.push({ type: "file", file_id: uploaded.id });
            continue;
          }
        }
      } catch (error) {
        console.warn(`[DeepSeek] image upload failed, falling back to URL: ${error.message}`);
      }
    }
    blocks.push({ type: "image_url", image_url: { url } });
  }
  return { role: "user", content: blocks };
}

function formatModels(payload) {
  const models = Array.isArray(payload?.data) ? payload.data : [];
  if (!models.length) return `${activeProviderConfig()?.name || activeProvider} 当前没有返回可用模型。`;
  return [`${activeProviderConfig()?.name || activeProvider} 模型列表：`, ...models.map((model) => {
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

async function executeProviderCommand(text) {
  if (!activeProviderConfig()) return null;
  if (/^\/models$/i.test(text)) {
    if (!activeProviderConfig().capabilities.modelList) return `当前服务商 ${activeProviderConfig().name} 不支持在线模型列表。`;
    return formatModels(await llm.listModels());
  }
  if (/^\/balance$/i.test(text)) {
    if (!activeProviderConfig().capabilities.balance) return `当前服务商 ${activeProviderConfig().name} 不提供余额查询。`;
    return formatBalance(await llm.getBalance());
  }
  if (/^\/files$/i.test(text)) {
    if (!activeProviderConfig().capabilities.files) return `当前服务商 ${activeProviderConfig().name} 不提供 Files API。`;
    return formatFiles(await llm.listFiles());
  }
  const fileGet = text.match(/^\/files\s+get\s+([A-Za-z0-9._:-]+)$/i);
  if (fileGet) {
    if (!activeProviderConfig().capabilities.files) return `当前服务商 ${activeProviderConfig().name} 不提供 Files API。`;
    return JSON.stringify(await llm.retrieveFile(fileGet[1]), null, 2).slice(0, STREAM_CONTENT_LIMIT);
  }
  const fileDelete = text.match(/^\/files\s+delete\s+([A-Za-z0-9._:-]+)$/i);
  if (fileDelete) {
    if (!activeProviderConfig().capabilities.files) return `当前服务商 ${activeProviderConfig().name} 不提供 Files API。`;
    await llm.deleteFile(fileDelete[1]);
    return `已删除文件：${fileDelete[1]}`;
  }
  const search = text.match(/^(?:\/search|搜索|网页搜索)\s+(.+)$/i);
  if (search) {
    if (!activeProviderConfig().capabilities.webSearch) return `当前服务商 ${activeProviderConfig().name} 不提供网页搜索。`;
    return formatSearch(await llm.webSearch(search[1], { parameters: { need_content: true } }));
  }
  const fetchMatch = text.match(/^(?:\/fetch|抓取|网页抓取)\s+(https?:\/\/\S+)$/i);
  if (fetchMatch) {
    if (!activeProviderConfig().capabilities.webSearch) return `当前服务商 ${activeProviderConfig().name} 不提供网页抓取。`;
    const page = await llm.fetchWebPage(fetchMatch[1]);
    return `${page.title || fetchMatch[1]}\n\n${page.content || "页面没有可提取内容。"}`.slice(0, STREAM_CONTENT_LIMIT);
  }
  return null;
}

async function runProviderTool(name, args = {}) {
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

async function handleProviderCommand(target, text) {
  const result = await executeProviderCommand(text);
  if (!result) return false;
  await sendTargetMessage(target, result);
  return true;
}

async function handleTextSettingCommand(target, text) {
  const providerMatch = text.match(/^\/provider\s+([A-Za-z0-9_-]+)$/i);
  if (providerMatch) {
    if (!switchProvider(providerMatch[1].toLowerCase())) {
      await sendTargetMessage(target, `未配置服务商：${providerMatch[1]}`);
    } else {
      await sendSettingsMenu(target, { prefix: `已切换服务商：**${activeProviderConfig().name}**` });
    }
    return true;
  }
  const modelMatch = text.match(/^\/model\s+([^\s]+)$/i);
  if (modelMatch) {
    const model = modelMatch[1];
    if (!MODEL_NAME_PATTERN.test(model) || !activeProviderConfig()?.models?.includes(model)) {
      await sendTargetMessage(target, `当前服务商没有模型：${model}`);
    } else {
      runtimeSettings.model = model;
      await sendSettingsMenu(target, { prefix: `已切换模型：**${model}**` });
    }
    return true;
  }
  const effortMatch = text.match(/^\/(?:think|reasoning)\s+(none|minimal|low|medium|high|xhigh|max)$/i);
  if (effortMatch) {
    runtimeSettings.reasoningEffort = effortMatch[1].toLowerCase();
    await sendSettingsMenu(target, { prefix: `已设置思考等级：**${EFFORT_LABELS[runtimeSettings.reasoningEffort]}**` });
    return true;
  }
  return false;
}

async function streamReply(target, history, requestOptions = {}) {
  const streamSettings = { ...runtimeSettings, ...requestOptions };
  if (target.kind !== "c2c") {
    let answer = "";
    let sentLength = 0;
    let lastSentAt = 0;
    let messageSeq = 1;
    const responseStream = activeCapabilities().tools && activeCapabilities().webSearch
      ? llm.streamWithTools(history, { ...streamSettings, tools: DEEPSEEK_TOOLS, toolHandler: runProviderTool })
      : llm.stream(history, streamSettings);
    for await (const delta of responseStream) {
      answer += delta;
      if (answer.length > sentLength && Date.now() - lastSentAt >= STREAM_UPDATE_INTERVAL_MS) {
        const chunk = answer.slice(sentLength, sentLength + STREAM_CONTENT_LIMIT);
        await sendTargetMessage(target, chunk, { msgSeq: messageSeq++ });
        sentLength += chunk.length;
        lastSentAt = Date.now();
      }
    }
    for (let offset = sentLength; offset < answer.length; offset += STREAM_CONTENT_LIMIT) {
      await sendTargetMessage(target, answer.slice(offset, offset + STREAM_CONTENT_LIMIT), { msgSeq: messageSeq++ });
    }
    if (!answer.trim()) throw new Error("LLM returned an empty response");
    return answer.trim();
  }

  const userId = target.id;
  const messageId = target.messageId;
  let answer = "";
  let streamMsgId = "";
  let sentAnswer = "";
  let lastSentAt = 0;
  let index = 0;
  let streamSupported = true;

  try {
    const responseStream = activeCapabilities().tools && activeCapabilities().webSearch
      ? llm.streamWithTools(history, {
        ...streamSettings,
        tools: DEEPSEEK_TOOLS,
        toolHandler: runProviderTool,
      })
      : llm.stream(history, streamSettings);
    for await (const delta of responseStream) {
      answer += delta;
      const content = answer.slice(0, STREAM_CONTENT_LIMIT);
      const shouldSend = content.trim() && content !== sentAnswer && (
        !streamMsgId || Date.now() - lastSentAt >= STREAM_UPDATE_INTERVAL_MS
      );
      if (shouldSend) {
        if (streamSupported) {
          try {
            const reply = await qqApi.sendC2CStreamMessage(userId, content, messageId, streamMsgId, 1, index);
            streamMsgId = reply.streamMsgId;
            if (!streamMsgId) throw new Error("QQ stream reply did not return stream message id");
          } catch (error) {
            streamSupported = false;
            streamMsgId = "";
            console.warn(`[C2C] stream endpoint unavailable, falling back to chunked messages: ${error.message}`);
          }
        }
        if (!streamSupported) await qqApi.sendC2CMessage(userId, content.slice(sentAnswer.length), messageId, index + 1);
        sentAnswer = content;
        index += 1;
        lastSentAt = Date.now();
      }
    }

    if (!answer.trim()) throw new Error("LLM returned an empty response");
    if (streamMsgId) {
      index += 1;
      await qqApi.sendC2CStreamMessage(userId, answer.slice(0, STREAM_CONTENT_LIMIT), messageId, streamMsgId, 10, index);
    } else if (sentAnswer.length < Math.min(answer.length, STREAM_CONTENT_LIMIT)) {
      index += 1;
      await qqApi.sendC2CMessage(userId, answer.slice(sentAnswer.length, STREAM_CONTENT_LIMIT), messageId, index + 1);
    }
    for (let offset = STREAM_CONTENT_LIMIT; offset < answer.length; offset += STREAM_CONTENT_LIMIT) {
      index += 1;
      await qqApi.sendC2CMessage(userId, answer.slice(offset, offset + STREAM_CONTENT_LIMIT), messageId, index + 1);
    }
    return answer.trim();
  } catch (error) {
    if (streamMsgId || sentAnswer) {
      error.streamStarted = true;
      if (streamMsgId) {
        const interrupted = `${answer.slice(0, STREAM_CONTENT_LIMIT)}\n\n（生成中断，请稍后重试）`.slice(0, STREAM_CONTENT_LIMIT);
        index += 1;
        await qqApi.sendC2CStreamMessage(userId, interrupted, messageId, streamMsgId, 10, index)
          .catch((replyError) => console.error("[C2C] failed to finalize stream reply:", replyError));
      }
    }
    throw error;
  }
}

async function handleEvent(type, data) {
  if (type === "INTERACTION_CREATE") return handleInteraction(data);
  const target = eventTarget(type, data);
  if (!target) return;
  const actorId = data?.author?.member_openid || data?.author?.user_openid || data?.author?.id || target.id;
  const memoryKey = `${target.kind}:${target.id}:${actorId}`;
  const queueKey = memoryKey;
  const messageId = target.messageId;
  const text = typeof data?.content === "string"
    ? data.content.replace(/<@!?\d+>/g, "").trim()
    : "";
  const attachments = messageAttachments(data);
  if (!actorId || !messageId || (!text && !attachments.length)) return;
  if (wasProcessed(messageId)) return;

  return enqueue(queueKey, async () => {
    if (wasProcessed(messageId)) return;

    if (/^\/reset$/i.test(text)) {
      memory.clear(memoryKey);
      await sendTargetMessage(target, "已清空当前上下文");
      markProcessed(messageId);
      return;
    }

    if (/^\/settings$/i.test(text)) {
      await sendSettingsMenu(target);
      markProcessed(messageId);
      return;
    }

    try {
      if (await handleTextSettingCommand(target, text)) {
        markProcessed(messageId);
        return;
      }
      if (await handleProviderCommand(target, text)) {
        markProcessed(messageId);
        return;
      }
    } catch (error) {
      console.error(`[QQ] provider command failed for ${actorId}:`, error);
      await sendTargetMessage(target, `操作失败：${error.message}`.slice(0, STREAM_CONTENT_LIMIT))
        .catch((replyError) => console.error("[C2C] failed to send command error:", replyError));
      markProcessed(messageId);
      return;
    }

    const userMessage = await buildUserMessage(text, attachments);
    memory.append(memoryKey, userMessage);

    try {
      const visionModel = attachments.length && activeProvider === "deepseek" ? activeProviderConfig()?.visionModel : "";
      const answer = await streamReply(target, memory.get(memoryKey), visionModel ? { model: visionModel } : {});
      memory.append(memoryKey, { role: "assistant", content: answer });
      markProcessed(messageId);
      console.log(`[QQ:${target.kind}] ${actorId}: ${text.slice(0, 80)} -> ${answer.slice(0, 80)}`);
    } catch (error) {
      memory.removeLast(memoryKey, userMessage);
      console.error(`[QQ:${target.kind}] failed for ${actorId}:`, error);
      if (!error.streamStarted) {
        await sendTargetMessage(target, "服务暂时繁忙，请稍后再试。").catch((replyError) => {
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
    response.end(JSON.stringify({ ok: true, service: "aneko-bot" }));
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
