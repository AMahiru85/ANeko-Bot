# ANeko-Bot

ANeko-Bot 是一个使用 QQ 官方机器人 Gateway 的 Node.js Agent。它按用户保存对话上下文，以流式消息把模型生成结果持续更新到 QQ，并通过 `/settings` 提供模型和能力设置。

模型能力和设置菜单的拆分参考 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)，QQ 接入使用官方 Open Platform HTTP/WebSocket 协议。

项目使用 Node.js 原生 `fetch`、`WebSocket` 和 `FormData`，不需要安装第三方 npm 依赖。运行环境要求 Node.js 22.4 或更高版本。

## 能力

- QQ C2C 私聊、群聊消息、频道消息和频道私信，包含消息去重、串行处理和 Gateway 心跳/断线重连。
- OpenAI-compatible 聊天接口，默认适配 DeepSeek、OpenAI、Moonshot 和通义千问，也支持 `CUSTOM_PROVIDERS_JSON` 自定义服务商。
- SSE 流式输出；C2C 使用 QQ stream message 接口逐步更新，群聊/频道按增量分段发送。
- DeepSeek 模型目录、余额、Files API、图像理解、Tool Calls、网页搜索和网页抓取。
- `/settings` Markdown 菜单按当前服务商的 capability 显示按钮，可切换服务商、模型和思考等级。
- `/settings` 的服务商、模型和思考等级是进程级管理设置，适合由管理员统一调整。
- `/reset` 清空当前用户上下文，`/health` 提供本机健康检查。

## 快速开始

### 本地运行

```bash
cp .env.example .env
# 编辑 .env，至少填写 QQ_APP_ID、QQ_APP_SECRET、AI_PROVIDER 对应的 API Key
node src/index.mjs
```

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

### 一键安装（Ubuntu/Debian）

根目录脚本是远程引导器：它会下载远程部署脚本，远程拉取仓库到 `/opt/aneko-bot`，安装 Node.js 22、创建 `aneko-bot` 系统用户、配置 systemd 并启动服务：

```bash
curl -fsSL https://raw.githubusercontent.com/AMahiru85/ANeko-Bot/main/install.sh | sudo bash
```

也可以直接指定远程仓库和安装目录：

```bash
curl -fsSL https://raw.githubusercontent.com/AMahiru85/ANeko-Bot/main/install.sh \
  | sudo env REPO_URL=https://github.com/your-org/ANeko-Bot.git \
      INSTALL_DIR=/opt/aneko-bot bash
```

已拉取到本地后，可以运行完整部署脚本：

```bash
sudo bash deploy/install.sh --install
```

常用管理命令：

```bash
sudo bash /opt/aneko-bot/deploy/install.sh --config
sudo bash /opt/aneko-bot/deploy/install.sh --status
sudo bash /opt/aneko-bot/deploy/install.sh --restart
sudo journalctl -u aneko-bot -f
```

默认安装目录为 `/opt/aneko-bot`，默认服务名和系统用户为 `aneko-bot`。远程引导器支持通过 `INSTALL_DIR`、`REPO_URL`、`INSTALLER_URL` 覆盖安装目录、仓库地址和部署脚本地址。

## QQ 开放平台

1. 在 [QQ 开放平台](https://q.qq.com/) 创建机器人并获取 AppID、AppSecret。
2. 为机器人开启 C2C 私聊以及需要使用的 Gateway intents。
3. 把凭据写入 `.env`。默认使用 QQ 官方当前地址 `https://api.bot.qq.com`，Token、REST 和 Gateway 地址均从该官方 API 根地址获取。

接口实现依据 QQ 官方 [访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)、[API 调用指南](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html)、[WebSocket Gateway](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html) 和 [C2C 流式消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_stream_messages.post.html) 文档。

如果使用旧版或代理网关，可通过 `QQ_AUTH_BASE`、`QQ_API_BASE`、`QQ_GATEWAY_URL` 覆盖地址。

## 环境变量

必填项：

| 变量 | 说明 |
| --- | --- |
| `QQ_APP_ID` | QQ 机器人 AppID |
| `QQ_APP_SECRET` | QQ 机器人 AppSecret；兼容旧名称 `QQ_CLIENT_SECRET` |
| `AI_PROVIDER` | 当前服务商，默认 `deepseek` |
| `DEEPSEEK_API_KEY` | `AI_PROVIDER=deepseek` 时必填 |

DeepSeek：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | OpenAI-compatible API 根地址 |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 默认模型 |
| `DEEPSEEK_MODELS` | `deepseek-chat,deepseek-reasoner` | 设置菜单中的本地模型选项 |
| `DEEPSEEK_VISION_MODEL` | `DEEPSEEK_MODEL` | 图片消息使用的模型 |
| `DEEPSEEK_API_STYLE` | `chat` | `chat` 使用 Chat Completions；`messages` 使用 harness 的 Anthropic 兼容 Messages 接口 |

其他内置服务商在填写对应 API Key 后自动出现在 `/settings`：

| 服务商 | API Key | 默认地址 | 默认模型 |
| --- | --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| Moonshot | `MOONSHOT_API_KEY` | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 通义千问 | `QWEN_API_KEY` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |

每个服务商都支持 `${PREFIX}_BASE_URL`、`${PREFIX}_MODEL`、`${PREFIX}_MODELS` 覆盖默认值。需要接入其他 OpenAI-compatible 服务时，可以填写 `OTHER_AI_BASE_URL`、`OTHER_AI_API_KEY`、`OTHER_AI_MODEL`，或使用 JSON：

```dotenv
CUSTOM_PROVIDERS_JSON=[{"id":"glm","name":"智谱","apiKeyEnv":"GLM_API_KEY","baseUrlEnv":"GLM_BASE_URL","defaultModelEnv":"GLM_MODEL","capabilities":{"vision":true}}]
```

通用运行参数：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LLM_REASONING_EFFORT` | `none` | `none`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max` |
| `SYSTEM_PROMPT` | 空 | Agent 系统提示词 |
| `MAX_CONTEXT_MESSAGES` | `20` | 每个用户保留的最大消息条数 |
| `STREAM_UPDATE_INTERVAL_MS` | `800` | QQ 流式消息更新间隔 |
| `WEB_SEARCH_ENABLED` | `true` | 是否启用网页工具 |
| `WEB_FETCH_TIMEOUT_MS` | `12000` | 网页抓取超时 |
| `HTTP_PORT` | `3000` | 健康检查端口 |

## QQ 命令

| 命令 | 作用 |
| --- | --- |
| `/settings` | 打开设置菜单。按钮按当前服务商能力显示。 |
| `/reset` | 清空当前用户的对话上下文。 |
| `/provider 服务商ID` | 在没有按钮权限的群聊/频道中切换服务商。 |
| `/model 模型名` | 在没有按钮权限的群聊/频道中切换模型。 |
| `/think 等级` | 设置 `none`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`。 |

DeepSeek 启用时还支持：

| 命令 | 作用 |
| --- | --- |
| `/models` | 获取 DeepSeek 模型及输入模态。 |
| `/balance` | 查询账户余额。 |
| `/files` | 列出 Files API 文件；`/files get 文件ID` 查看详情，`/files delete 文件ID` 删除文件。 |
| `/search 关键词` | 搜索网页。也支持 `搜索 关键词`。 |
| `/fetch https://...` | 抓取网页 Markdown。也支持 `抓取 https://...`。 |

发送图片时，机器人会优先使用 DeepSeek Files API 上传后以 `file_id` 传入；上传失败时回退到图片 URL。模型没有视觉能力时，菜单不会显示图像理解按钮。

## 目录

```text
src/
├── config.mjs       # .env、服务商和 capability 配置
├── index.mjs        # 消息处理、设置菜单和健康检查
├── llm.mjs          # SSE、Tool Calls、Files 和 DeepSeek API
├── memory.mjs       # 每用户进程内会话记忆
├── qq-api.mjs       # QQ Token、C2C/群/频道消息、Markdown 和流式接口
└── qq-gateway.mjs   # Gateway WebSocket、心跳、Resume 和重连
deploy/
├── install.sh       # 一键安装和 systemd 管理
└── aneko-bot.service
```

## 许可

本项目使用 MIT License，见 [LICENSE](LICENSE)。
