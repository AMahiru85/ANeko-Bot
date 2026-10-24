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

export const config = {
  rootDir,
  qqAppId: required("QQ_APP_ID"),
  qqClientSecret: required("QQ_CLIENT_SECRET"),
  qqApiBase: process.env.QQ_API_BASE?.trim() || "https://api.bot.qq.com",
  qqGatewayUrl: process.env.QQ_GATEWAY_URL?.trim() || "",
  qqIntents: Number.parseInt(process.env.QQ_INTENTS || "33554432", 10),
  llmApiKey: required("LLM_API_KEY"),
  llmBaseUrl: process.env.LLM_BASE_URL?.trim() || "https://api.deepseek.com",
  llmModel: process.env.LLM_MODEL?.trim() || "deepseek-chat",
  systemPrompt: process.env.SYSTEM_PROMPT?.trim() || "你是一个可靠、简洁的 QQ 私聊助手。请用中文回答，无法确定时明确说明。",
  httpPort: Number.parseInt(process.env.HTTP_PORT || "3000", 10),
};

if (!Number.isInteger(config.qqIntents) || config.qqIntents <= 0) {
  throw new Error("QQ_INTENTS must be a positive integer");
}
