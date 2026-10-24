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

async function handleEvent(type, data) {
  if (type !== "C2C_MESSAGE_CREATE") return;

  const userId = data?.author?.user_openid;
  const messageId = data?.id;
  const text = typeof data?.content === "string" ? data.content.trim() : "";
  if (!userId || !messageId || !text) return;
  if (wasProcessed(messageId)) return;

  return enqueue(userId, async () => {
    if (wasProcessed(messageId)) return;

    if (/^\/(reset|clear)$/i.test(text)) {
      memory.clear(userId);
      await qqApi.sendC2CMessage(userId, "已清空当前私聊上下文。", messageId);
      markProcessed(messageId);
      return;
    }

    const userMessage = { role: "user", content: text };
    memory.append(userId, userMessage);

    try {
      const answer = await llm.chat(memory.get(userId));
      memory.append(userId, { role: "assistant", content: answer });
      await qqApi.sendC2CMessage(userId, answer, messageId);
      markProcessed(messageId);
      console.log(`[C2C] ${userId}: ${text.slice(0, 80)} -> ${answer.slice(0, 80)}`);
    } catch (error) {
      memory.removeLast(userId, userMessage);
      console.error(`[C2C] failed for ${userId}:`, error);
      await qqApi.sendC2CMessage(userId, "服务暂时繁忙，请稍后再试。", messageId).catch((replyError) => {
        console.error("[C2C] failed to send error reply:", replyError);
      });
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
  intents: config.qqIntents,
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
