# ANeko Bot

基于 Node.js 的 QQ 官方机器人私聊 Agent。服务通过 QQ 官方 Gateway 接收 `C2C_MESSAGE_CREATE` 事件，调用 OpenAI 兼容格式的 LLM API，再通过 QQ 官方 API 回复用户。

项目使用官方 Bot 身份和 Access Token，不需要 NapCat、个人 QQ 登录或公网回调地址。

## 项目能力

| 能力 | 说明 |
| --- | --- |
| QQ 私聊 | 接收并回复 `C2C_MESSAGE_CREATE` 事件 |
| LLM 对话 | 支持 DeepSeek 以及其他 OpenAI 兼容接口 |
| 会话记忆 | 按用户保存最近若干轮对话，进程重启后清空 |
| 消息去重 | 防止 QQ 重复推送导致重复调用和重复回复 |
| Gateway 保活 | 自动心跳、断线重连和 Session Resume |
| 管理命令 | 发送 `/reset` 或 `/clear` 清空当前用户上下文 |
| 健康检查 | 提供本机 `/health` 接口 |

## 工作流程

```text
QQ 用户私聊
    ↓
QQ 官方 Gateway WebSocket
    ↓ C2C_MESSAGE_CREATE
消息处理与会话记忆
    ↓
OpenAI 兼容 LLM API
    ↓
QQ 官方 C2C 消息接口
    ↓
用户收到回复
```

## QQ 开放平台配置

1. 在 [QQ 开放平台](https://q.qq.com/) 创建机器人。
2. 获取 `AppID` 和 `AppSecret`。
3. 在事件订阅或消息权限中开启 C2C 私聊消息。
4. 将测试账号加入机器人可用范围。

`QQ_INTENTS` 不是开放平台后台的输入项，而是程序连接 Gateway 时发送的 `Identify` 位掩码。代码默认使用 `33554432`（`1 << 25`），通常不需要修改。官方机器人通常只能向平台允许的测试用户或已建立会话的用户回复，具体权限以开放平台后台为准。

## 环境变量

复制 `.env.example` 为 `.env`，按下表填写：

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `QQ_APP_ID` | 是 | - | QQ 机器人 AppID |
| `QQ_CLIENT_SECRET` | 是 | - | QQ 机器人 AppSecret |
| `QQ_API_BASE` | 否 | `https://api.bot.qq.com` | QQ OpenAPI 地址 |
| `QQ_GATEWAY_URL` | 否 | 自动获取 | 自定义 Gateway 地址 |
| `QQ_INTENTS` | 否 | `33554432` | Gateway Identify 位掩码，通常不需要修改 |
| `LLM_API_KEY` | 是 | - | LLM 服务商 API Key |
| `LLM_BASE_URL` | 否 | `https://api.deepseek.com` | OpenAI 兼容 API 根地址 |
| `LLM_MODEL` | 否 | `deepseek-chat` | 模型名称 |
| `SYSTEM_PROMPT` | 否 | 中文助手提示词 | Agent 的系统提示词 |
| `HISTORY_LIMIT` | 否 | `12` | 每个用户保留的消息条数 |
| `HTTP_PORT` | 否 | `3000` | 本机健康检查端口 |

默认配置使用 DeepSeek 作为示例。切换到其他 OpenAI 兼容服务时，只需要修改 `LLM_API_KEY`、`LLM_BASE_URL` 和 `LLM_MODEL`。

示例：

```dotenv
QQ_APP_ID=your-qq-app-id
QQ_CLIENT_SECRET=your-qq-client-secret
QQ_INTENTS=33554432

LLM_API_KEY=your-llm-api-key
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
SYSTEM_PROMPT=你是一个可靠、简洁的 QQ 私聊助手。请用中文回答，无法确定时明确说明。
HISTORY_LIMIT=12
HTTP_PORT=3000
```

不要把 `.env` 或任何 API Key 提交到 Git。

## 本地运行

要求 Node.js 22.4 或更高版本。项目使用 Node.js 内置的 `fetch` 和 WebSocket，不需要额外安装运行时依赖。

```bash
git clone https://github.com/AMahiru85/ANeko-Bot.git
cd ANeko-Bot
cp .env.example .env
# 编辑 .env
node src/index.mjs
```

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

成功响应：

```json
{"ok":true,"service":"qq-llm-agent"}
```

## Linux 部署

### 安装运行环境

以下命令适用于 Ubuntu 或 Debian：

```bash
sudo apt update
sudo apt install -y git curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version
```

### 部署项目

```bash
sudo useradd --system --home /opt/qq-llm-agent \
  --shell /usr/sbin/nologin qqbot

sudo git clone https://github.com/AMahiru85/ANeko-Bot.git \
  /opt/qq-llm-agent

sudo chown -R qqbot:qqbot /opt/qq-llm-agent
sudo cp /opt/qq-llm-agent/.env.example /opt/qq-llm-agent/.env
sudo nano /opt/qq-llm-agent/.env
sudo chmod 600 /opt/qq-llm-agent/.env
```

### 注册 systemd 服务

```bash
sudo cp /opt/qq-llm-agent/deploy/qq-llm-agent.service \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qq-llm-agent
```

查看运行状态：

```bash
sudo systemctl status qq-llm-agent
sudo journalctl -u qq-llm-agent -f
```

服务只需要主动访问 QQ 和 LLM 服务商的 HTTPS/WSS 地址，不需要开放公网端口。健康检查仅监听 `127.0.0.1`。

### 更新项目

```bash
cd /opt/qq-llm-agent
sudo git pull --ff-only
sudo systemctl restart qq-llm-agent
```

## 服务器配置

| 使用规模 | 建议配置 |
| --- | --- |
| 个人测试 | 1 核 CPU、1 GB 内存、10 GB SSD |
| 长期运行 | 2 核 CPU、2 GB 内存、20 GB SSD |
| 较多并发 | 2-4 核 CPU、4 GB 内存 |

当前项目调用云端 LLM，不需要 GPU。对话记录保存在进程内存中，重启服务后会清空。

## 项目结构

```text
src/
├── config.mjs       # 环境变量加载与校验
├── index.mjs        # 服务入口、消息处理和健康检查
├── llm.mjs          # OpenAI 兼容 LLM 客户端
├── memory.mjs       # 按用户隔离的短期会话记忆
├── qq-api.mjs       # QQ Access Token 和 C2C REST API
└── qq-gateway.mjs   # QQ Gateway WebSocket、心跳和 Resume
deploy/
└── qq-llm-agent.service  # systemd 服务配置
.env.example         # 环境变量模板
package.json         # 项目元数据与运行命令
```

## 故障排查

| 现象 | 检查项 |
| --- | --- |
| 启动后立即退出 | 检查 `QQ_APP_ID`、`QQ_CLIENT_SECRET`、`LLM_API_KEY` 是否填写 |
| QQ 返回 `appid invalid` | 检查 AppID、机器人状态和开放平台环境 |
| 没有收到私聊事件 | 检查后台是否开启 C2C 私聊权限、测试账号范围和 Gateway 日志 |
| Gateway 报 `4014` | 当前机器人没有对应 Intent 权限，调整开放平台事件订阅 |
| LLM 返回 `401` | 检查 `LLM_API_KEY` |
| LLM 返回 `404` | 检查 `LLM_BASE_URL` 是否包含正确的 API 根地址以及模型名称 |
| 健康检查正常但不回复 | 查看 `journalctl -u qq-llm-agent -f`，确认 Gateway 和 LLM 请求状态 |
| 回复消息过期 | 检查服务器网络和 LLM 响应耗时，确保服务能及时处理事件 |

## 源码与许可证

| 项目 | 地址 |
| --- | --- |
| 源码仓库 | [AMahiru85/ANeko-Bot](https://github.com/AMahiru85/ANeko-Bot) |
| QQ 官方机器人文档 | [bot.q.qq.com](https://bot.q.qq.com/wiki/develop/api-v2/) |
| 许可证 | 暂未声明 |
