# ANeko Bot

基于 Node.js 的 QQ 官方机器人 Agent。

## 项目

| 能力 | 说明 |
| --- | --- |
| QQ 互动 | 支持 C2C 私聊、群聊、频道消息和频道私信；使用官方 Gateway WebSocket 接收事件 |
| 流式回复 | C2C 使用官方 stream message 接口更新生成内容；群聊和频道按消息分段发送 |
| 模型服务 | DeepSeek、OpenAI、Moonshot、通义千问，以及自定义 OpenAI-compatible 服务商 |
| DeepSeek 能力 | 在线模型列表、余额查询、图像理解、Tool Calls、Files API、网页搜索和网页抓取 |
| 模型设置 | `/settings` 按当前服务商能力展示模型、思考等级和工具入口 |
| 会话记忆 | 按聊天场景、会话和用户隔离；保存在进程内，服务重启后清空 |
| Gateway 保活 | 自动心跳、断线重连和 Session Resume |
| 管理命令 | `/settings` 打开设置，`/reset` 清空当前会话上下文 |
| 健康检查 | 提供本机 `GET /health` 接口 |

## 工作流程

```text
用户
    ↓
QQ 官方 Gateway WebSocket
    ↓ 消息事件 / 按钮交互事件
消息处理、去重与会话记忆
    ↓ SSE 流式请求
AI 服务商
    ↓ 流式文本 / Tool Calls
QQ 官方消息接口
    ↓
用户收到更新回复
```

## QQ 开放平台配置

1. 在 [QQ 开放平台](https://q.qq.com/) 创建机器人。
2. 获取机器人 `AppID` 和 `AppSecret`。

接口依据 QQ 官方 [访问凭证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)、[API 调用指南](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/api-call-guide.html)、[WebSocket Gateway](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/event-emit/websocket.html) 和 [消息收发文档](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html) 实现。需要使用代理或自定义网关时，可通过 `QQ_AUTH_BASE`、`QQ_API_BASE` 和 `QQ_GATEWAY_URL` 覆盖地址。

## 部署

部署脚本适用于适用于使用了 systemd 的发行版（Ubuntu、Debian...）。

```bash
curl -fsSL https://raw.githubusercontent.com/AMahiru85/ANeko-Bot/main/install.sh | sudo bash
```

已克隆仓库时，可直接运行完整部署程序：

```bash
sudo bash deploy/install.sh --install
```

安装完成后，可使用以下命令配置、检查和管理服务：

```bash
sudo bash /opt/aneko-bot/deploy/install.sh --config
sudo bash /opt/aneko-bot/deploy/install.sh --status
sudo bash /opt/aneko-bot/deploy/install.sh --restart
sudo bash /opt/aneko-bot/deploy/install.sh --upgrade
sudo journalctl -u aneko-bot -f
```

默认安装目录是 `/opt/aneko-bot`，systemd 服务名和运行用户均为 `aneko-bot`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/settings` | 打开模型设置菜单；菜单项按服务商能力显示 |
| `/reset` | 清空当前会话上下文 |
| `/provider 服务商ID` | 切换已配置服务商 |
| `/model 模型名` | 切换当前服务商的模型 |
| `/think 等级` | 设置思考等级：`none`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max` |

配置 DeepSeek 后还可使用：

| 命令 | 作用 |
| --- | --- |
| `/models` | 查询在线模型及输入模态 |
| `/balance` | 查询账户余额 |
| `/files` | 列出 Files API 文件；可用 `/files get 文件ID` 查看或 `/files delete 文件ID` 删除 |
| `/search 关键词` | 搜索网页，也支持 `搜索 关键词` |
| `/fetch https://...` | 抓取网页 Markdown，也支持 `抓取 https://...` |

发送图片时，DeepSeek 优先通过 Files API 上传并传入 `file_id`；上传失败时回退到图片 URL。图像理解取决于所选模型的视觉能力。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `QQ_APP_ID` | 是 | - | QQ 机器人 AppID |
| `QQ_APP_SECRET` | 是 | - | QQ 机器人 AppSecret；兼容 `QQ_CLIENT_SECRET` |
| `QQ_AUTH_BASE` | 否 | `https://api.bot.qq.com` | 获取访问凭证的 API 根地址 |
| `QQ_API_BASE` | 否 | `https://api.bot.qq.com` | QQ REST API 根地址 |
| `QQ_GATEWAY_URL` | 否 | 自动获取 | 自定义 WebSocket Gateway 地址 |
| `QQ_INTENTS` | 否 | `100667392` | Gateway Identify 位掩码；控制台也需开通对应事件权限 |
| `AI_PROVIDER` | 否 | `deepseek` | 默认服务商：`deepseek`、`openai`、`moonshot`、`qwen`、`other` 或自定义 ID |
| `DEEPSEEK_API_KEY` | DeepSeek 必填 | - | DeepSeek API Key |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com` | DeepSeek API 根地址 |
| `DEEPSEEK_API_STYLE` | 否 | `chat` | `chat` 使用 Chat Completions；`messages` 使用 Anthropic-compatible Messages API |
| `DEEPSEEK_MODEL` | 否 | `deepseek-chat` | 默认模型 |
| `DEEPSEEK_MODELS` | 否 | `deepseek-chat,deepseek-reasoner` | `/settings` 的模型选项；在线列表可刷新模型元数据 |
| `DEEPSEEK_VISION_MODEL` | 否 | `DEEPSEEK_MODEL` | 图片消息使用的模型 |
| `OPENAI_API_KEY` | OpenAI 可选 | - | 配置后启用 OpenAI 服务商 |
| `OPENAI_BASE_URL` | 否 | `https://api.openai.com/v1` | OpenAI API 根地址 |
| `OPENAI_MODEL` | 否 | `gpt-4o-mini` | 默认模型；可用 `OPENAI_MODELS` 设置列表 |
| `OPENAI_MODELS` | 否 | `gpt-4o-mini,gpt-4o` | `/settings` 中可选的 OpenAI 模型 |
| `MOONSHOT_API_KEY` | Moonshot 可选 | - | 配置后启用 Moonshot 服务商 |
| `MOONSHOT_BASE_URL` | 否 | `https://api.moonshot.cn/v1` | Moonshot API 根地址 |
| `MOONSHOT_MODEL` | 否 | `moonshot-v1-8k` | 默认模型；可用 `MOONSHOT_MODELS` 设置列表 |
| `MOONSHOT_MODELS` | 否 | `moonshot-v1-8k,moonshot-v1-32k` | `/settings` 中可选的 Moonshot 模型 |
| `QWEN_API_KEY` | 通义千问可选 | - | 配置后启用通义千问服务商 |
| `QWEN_BASE_URL` | 否 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | API 根地址 |
| `QWEN_MODEL` | 否 | `qwen-plus` | 默认模型；可用 `QWEN_MODELS` 设置列表 |
| `QWEN_MODELS` | 否 | `qwen-plus,qwen-max` | `/settings` 中可选的通义千问模型 |
| `OTHER_AI_BASE_URL` | 使用 `other` 时必填 | - | 自定义 OpenAI-compatible API 根地址 |
| `OTHER_AI_API_KEY` | 使用 `other` 时必填 | - | 自定义服务商 API Key |
| `OTHER_AI_MODEL` | 使用 `other` 时必填 | - | 自定义服务商默认模型 |
| `CUSTOM_PROVIDERS_JSON` | 否 | `[]` | 自定义多个服务商，可使用固定值或 `*Env` 环境变量名 |
| `LLM_REASONING_EFFORT` | 否 | `none` | 默认思考等级：`none`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max` |
| `SYSTEM_PROMPT` | 否 | 空 | Agent 系统提示词 |
| `MAX_CONTEXT_MESSAGES` | 否 | `20` | 每个会话保留的消息条数 |
| `STREAM_UPDATE_INTERVAL_MS` | 否 | `800` | QQ 流式消息更新间隔（毫秒） |
| `WEB_SEARCH_ENABLED` | 否 | `true` | 启用网页工具入口 |
| `WEB_FETCH_TIMEOUT_MS` | 否 | `12000` | 网页抓取超时（毫秒） |
| `HTTP_PORT` | 否 | `3000` | 本机健康检查端口 |

基础配置示例：

```dotenv
QQ_APP_ID=your-qq-app-id
QQ_APP_SECRET=your-qq-app-secret
QQ_INTENTS=100667392

AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=your-deepseek-api-key
DEEPSEEK_MODEL=deepseek-chat
LLM_REASONING_EFFORT=none
SYSTEM_PROMPT=
HTTP_PORT=3000
```

使用其他 OpenAI-compatible 服务商：

```dotenv
AI_PROVIDER=other
OTHER_AI_BASE_URL=https://example.com/v1
OTHER_AI_API_KEY=your-api-key
OTHER_AI_MODEL=your-model-name
```

也可以通过 `CUSTOM_PROVIDERS_JSON` 定义服务商及能力：

```dotenv
CUSTOM_PROVIDERS_JSON=[{"id":"glm","name":"智谱","apiKeyEnv":"GLM_API_KEY","baseUrlEnv":"GLM_BASE_URL","defaultModelEnv":"GLM_MODEL","capabilities":{"vision":true}}]
```

## 项目结构

```text
src/
├── config.mjs       # 环境变量加载、模型服务商和能力配置
├── index.mjs        # 消息处理、设置菜单、命令和健康检查
├── llm.mjs          # 模型 API、SSE、Tool Calls、Files 和网页工具
├── memory.mjs       # 进程内会话记忆
├── qq-api.mjs       # QQ Token、消息、交互和流式 API
└── qq-gateway.mjs   # Gateway WebSocket、心跳、Resume 和重连
deploy/
├── install.sh       # Linux 一键安装和 systemd 管理
└── aneko-bot.service
install.sh           # 远程 Linux 安装引导脚本
.env.example         # 环境变量模板
package.json         # 项目元数据与运行命令
LICENSE              # MIT 许可证
```

## 源码与许可

| 项目 | 地址 |
| --- | --- |
| ANeko-Bot 源码 | [AMahiru85/ANeko-Bot](https://github.com/AMahiru85/ANeko-Bot) |
| QQ 官方机器人文档 | [bot.q.qq.com](https://bot.q.qq.com/wiki/develop/api-v2/) |
| 许可证 | [MIT](LICENSE) |
