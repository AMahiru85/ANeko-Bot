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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseModelList(value, fallback) {
  const models = [fallback, ...(value || "").split(",")]
    .map((model) => model.trim())
    .filter((model) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model));
  return [...new Set(models.length ? models : [fallback])].slice(0, 20);
}

const llmModel = process.env.LLM_MODEL?.trim() || "deepseek-chat";

export const config = {
  rootDir,
  qqAppId: required("QQ_APP_ID"),
  qqClientSecret: required("QQ_CLIENT_SECRET"),
  qqApiBase: process.env.QQ_API_BASE?.trim() || "https://api.bot.qq.com",
  qqGatewayUrl: process.env.QQ_GATEWAY_URL?.trim() || "",
  qqIntents: Number.parseInt(process.env.QQ_INTENTS || "33554432", 10),
  llmApiKey: required("LLM_API_KEY"),
  llmBaseUrl: process.env.LLM_BASE_URL?.trim() || "https://api.deepseek.com",
  llmModel,
  llmModels: parseModelList(process.env.LLM_MODELS, llmModel),
  llmReasoningEffort: process.env.LLM_REASONING_EFFORT?.trim().toLowerCase() || "none",
  systemPrompt: process.env.SYSTEM_PROMPT?.trim() || "",
  httpPort: Number.parseInt(process.env.HTTP_PORT || "3000", 10),
};

if (!Number.isInteger(config.qqIntents) || config.qqIntents <= 0) {
  throw new Error("QQ_INTENTS must be a positive integer");
}

if (!Number.isInteger(config.httpPort) || config.httpPort < 1 || config.httpPort > 65_535) {
  throw new Error("HTTP_PORT must be an integer between 1 and 65535");
}

if (!/^(none|minimal|low|medium|high|xhigh)$/.test(config.llmReasoningEffort)) {
  throw new Error("LLM_REASONING_EFFORT must be one of: none, minimal, low, medium, high, xhigh");
}
