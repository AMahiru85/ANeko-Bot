import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadDotEnv() {
  const envPath = path.join(rootDir, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function csv(name) {
  return (process.env[name] || "").split(",").map((value) => value.trim()).filter(Boolean);
}

function bool(name, fallback) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return !["0", "false", "no", "off"].includes(value);
}

function number(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

const commonCapabilities = {
  tools: true,
  vision: false,
  files: false,
  webSearch: false,
  balance: false,
  modelList: false,
  reasoning: true,
};

function providerFromEnv(id, name, envPrefix, defaults) {
  const apiKey = process.env[`${envPrefix}_API_KEY`]?.trim() || "";
  if (!apiKey) return null;
  const baseUrl = process.env[`${envPrefix}_BASE_URL`]?.trim() || defaults.baseUrl;
  const defaultModel = process.env[`${envPrefix}_MODEL`]?.trim() || defaults.defaultModel;
  const models = csv(`${envPrefix}_MODELS`);
  return {
    id,
    name,
    apiKey,
    baseUrl,
    defaultModel,
    apiStyle: process.env[`${envPrefix}_API_STYLE`]?.trim().toLowerCase() || "chat",
    models: models.length ? models : [defaultModel],
    capabilities: { ...commonCapabilities, ...defaults.capabilities },
  };
}

const providers = {};
const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim() || "";
if (deepseekKey) {
  const deepseekModels = csv("DEEPSEEK_MODELS");
  providers.deepseek = {
    id: "deepseek",
    name: "DeepSeek",
    apiKey: deepseekKey,
    baseUrl: process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com",
    apiStyle: process.env.DEEPSEEK_API_STYLE?.trim().toLowerCase() || "chat",
    defaultModel: process.env.DEEPSEEK_MODEL?.trim() || "deepseek-chat",
    visionModel: process.env.DEEPSEEK_VISION_MODEL?.trim() || process.env.DEEPSEEK_MODEL?.trim() || "deepseek-chat",
    models: deepseekModels.length ? deepseekModels : ["deepseek-chat", "deepseek-reasoner"],
    capabilities: { tools: true, vision: true, files: true, webSearch: true, balance: true, modelList: true, reasoning: true },
  };
}

const builtIns = [
  providerFromEnv("openai", "OpenAI", "OPENAI", { baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini", capabilities: { vision: true, files: true, modelList: true } }),
  providerFromEnv("moonshot", "Moonshot", "MOONSHOT", { baseUrl: "https://api.moonshot.cn/v1", defaultModel: "moonshot-v1-8k", capabilities: { vision: true } }),
  providerFromEnv("qwen", "通义千问", "QWEN", { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", defaultModel: "qwen-plus", capabilities: { vision: true } }),
  providerFromEnv("siliconflow", "SiliconFlow", "SILICONFLOW", { baseUrl: "https://api.siliconflow.cn/v1", defaultModel: "deepseek-ai/DeepSeek-V3", capabilities: { vision: true } }),
].filter(Boolean);
for (const provider of builtIns) providers[provider.id] = provider;

if (!providers.other && process.env.OTHER_AI_API_KEY?.trim()) {
  providers.other = {
    id: "other",
    name: "兼容模型",
    apiKey: required("OTHER_AI_API_KEY"),
    baseUrl: required("OTHER_AI_BASE_URL"),
    defaultModel: required("OTHER_AI_MODEL"),
    models: [required("OTHER_AI_MODEL")],
    capabilities: { ...commonCapabilities, vision: true },
  };
}

let customProviders = [];
try {
  const parsed = JSON.parse(process.env.CUSTOM_PROVIDERS_JSON?.trim() || "[]");
  if (Array.isArray(parsed)) customProviders = parsed;
} catch (error) {
  throw new Error(`CUSTOM_PROVIDERS_JSON is invalid: ${error.message}`);
}
for (const item of customProviders) {
  if (!item || typeof item.id !== "string" || !item.id.trim()) continue;
  const id = item.id.trim().toLowerCase();
  const apiKey = item.apiKey || process.env[item.apiKeyEnv || ""] || "";
  const baseUrl = item.baseUrl || process.env[item.baseUrlEnv || ""] || "";
  const defaultModel = item.defaultModel || process.env[item.defaultModelEnv || ""] || item.models?.[0] || "";
  if (!apiKey || !baseUrl || !defaultModel) continue;
  providers[id] = { id, name: item.name || id, apiKey, baseUrl, apiStyle: item.apiStyle || "chat", defaultModel, models: Array.isArray(item.models) && item.models.length ? item.models : [defaultModel], capabilities: { ...commonCapabilities, ...(item.capabilities || {}) } };
}

const aiProvider = process.env.AI_PROVIDER?.trim().toLowerCase() || "deepseek";
if (!providers[aiProvider]) {
  throw new Error(`AI_PROVIDER=${aiProvider} is not configured. Set its API key first. Available: ${Object.keys(providers).join(", ") || "none"}`);
}
const selected = providers[aiProvider];
const qqAppSecret = process.env.QQ_APP_SECRET?.trim() || process.env.QQ_CLIENT_SECRET?.trim();

export const config = {
  rootDir,
  aiProvider,
  providers,
  qqAppId: required("QQ_APP_ID"),
  qqAppSecret: qqAppSecret || required("QQ_APP_SECRET"),
  qqAuthBase: process.env.QQ_AUTH_BASE?.trim() || "https://bots.qq.com",
  qqApiBase: process.env.QQ_API_BASE?.trim() || "https://api.sgroup.qq.com",
  qqGatewayUrl: process.env.QQ_GATEWAY_URL?.trim() || "",
  qqIntents: number("QQ_INTENTS", (1 << 25) | (1 << 26) | (1 << 12)),
  llmApiKey: selected.apiKey,
  llmBaseUrl: selected.baseUrl,
  llmModel: selected.defaultModel,
  llmApiStyle: selected.apiStyle || "chat",
  llmReasoningEffort: process.env.LLM_REASONING_EFFORT?.trim().toLowerCase() || "none",
  systemPrompt: process.env.SYSTEM_PROMPT?.trim() || "",
  httpPort: number("HTTP_PORT", 3000),
  streamUpdateIntervalMs: number("STREAM_UPDATE_INTERVAL_MS", 800),
  maxContextMessages: number("MAX_CONTEXT_MESSAGES", 20),
  webSearchEnabled: bool("WEB_SEARCH_ENABLED", true),
  webFetchTimeoutMs: number("WEB_FETCH_TIMEOUT_MS", 12_000),
};

if (!Number.isInteger(config.qqIntents) || config.qqIntents <= 0) throw new Error("QQ_INTENTS must be a positive integer");
if (!Number.isInteger(config.httpPort) || config.httpPort < 1 || config.httpPort > 65_535) throw new Error("HTTP_PORT must be between 1 and 65535");
if (!/^(none|minimal|low|medium|high|xhigh|max)$/.test(config.llmReasoningEffort)) throw new Error("LLM_REASONING_EFFORT is invalid");
