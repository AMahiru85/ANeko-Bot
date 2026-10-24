# ANeko Bot

基于 Node.js 的 QQ 官方机器人私聊 Agent。服务通过 QQ 官方 Gateway 接收 `C2C_MESSAGE_CREATE` 事件，调用 OpenAI 兼容格式的 LLM API，使用 QQ 官方 API 回复。

## 项目

| 能力 | 说明 |
| --- | --- |
| QQ 私聊 | 接收并回复 `C2C_MESSAGE_CREATE` 事件 |
| LLM 对话 | 支持 DeepSeek 以及其他 OpenAI 兼容接口 |
| 会话记忆 | 按用户保存当前进程内的完整对话，进程重启后清空 |
| 消息去重 | 防止 QQ 重复推送导致重复调用和重复回复 |
| Gateway 保活 | 自动心跳、断线重连和 Session Resume |
| 管理命令 | 发送 `/reset` 或 `/clear` 清空当前用户上下文 |
| 健康检查 | 提供本机 `/health` 接口 |

## 工作流程

```text
QQ 用户
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

## 部署

以下命令适用于 Ubuntu 或 Debian。

### 一键部署

执行脚本会进入 ANeko-Bot 管理菜单，可选择安装、升级、卸载、更新配置、查看状态、重启和停止服务。选择安装时，脚本会安装 Node.js 22 和 Git，创建 `qqbot` 运行用户，拉取项目并安装 systemd 服务；首次安装会安全询问三个必填密钥。

```bash
curl -fsSL https://raw.githubusercontent.com/AMahiru85/ANeko-Bot/main/deploy/install.sh | sudo bash
```

菜单选项包括：安装、升级、卸载、更新配置、查看服务状态、重启服务、停止服务和退出。

脚本可以重复执行，不会覆盖已有的 `.env`。默认安装目录是 `/opt/qq-llm-agent`，服务名是 `qq-llm-agent`。如需从其他仓库或目录部署，可以在执行前设置 `REPO_URL` 或 `INSTALL_DIR` 环境变量，脚本会同步生成对应的 systemd 路径。

#### 脚本参数

| 参数 | 作用 |
| --- | --- |
| 无参数、`--menu` | 打开 ANeko-Bot 管理菜单；默认行为 |
| `--install` | 安装 ANeko-Bot，创建配置；配置完整后启动服务 |
| `--upgrade` | 拉取最新代码，更新 systemd 配置；配置完整后重启服务 |
| `--uninstall` | 停止并删除服务、项目目录和运行用户；需要输入 `UNINSTALL` 确认 |
| `--config` | 编辑 `.env` 配置，配置有效后自动重启服务 |
| `--status` | 查看 systemd 服务状态和本机健康检查 |
| `--restart` | 重启服务 |
| `--stop` | 停止服务 |

部署变量：

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `REPO_URL` | `https://github.com/AMahiru85/ANeko-Bot.git` | 指定要拉取的 Git 仓库 |
| `INSTALL_DIR` | `/opt/qq-llm-agent` | 指定项目安装目录，脚本会同步生成 systemd 路径 |

示例：

```bash
sudo bash /opt/qq-llm-agent/deploy/install.sh --status
sudo bash /opt/qq-llm-agent/deploy/install.sh --config
```

### 手动部署

#### 1. 安装 Node.js 22 和 Git

```bash
sudo apt update
sudo apt install -y git curl

curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

node -v
```

#### 2. 创建运行用户并拉取项目

```bash
sudo useradd --system --home /opt/qq-llm-agent \
  --shell /usr/sbin/nologin qqbot

sudo git clone https://github.com/AMahiru85/ANeko-Bot.git \
  /opt/qq-llm-agent

sudo chown -R qqbot:qqbot /opt/qq-llm-agent
```

#### 3. 配置密钥

```bash
sudo cp /opt/qq-llm-agent/.env.example /opt/qq-llm-agent/.env
sudo nano /opt/qq-llm-agent/.env
```

填写 QQ 和 LLM 配置：

具体配置请参考[环境变量表](#环境变量)。

保存后设置权限：

```bash
sudo chown qqbot:qqbot /opt/qq-llm-agent/.env
sudo chmod 600 /opt/qq-llm-agent/.env
```

#### 4. 安装并启动 systemd 服务

```bash
sudo cp /opt/qq-llm-agent/deploy/qq-llm-agent.service \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qq-llm-agent
```

#### 5. 查看状态和日志

```bash
sudo systemctl status qq-llm-agent
sudo journalctl -u qq-llm-agent -f
```

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

返回以下内容说明服务已启动：

```json
{"ok":true,"service":"qq-llm-agent"}
```

服务器不需要开放公网端口，只要允许访问 QQ 官方 API、Gateway 和 LLM 服务商的 HTTPS/WSS 地址即可。

## 环境变量

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
| `HTTP_PORT` | 否 | `3000` | 本机健康检查端口 |

默认配置使用 DeepSeek 作为示例。切换到其他 OpenAI 兼容服务时，只需要修改 `LLM_API_KEY`、`LLM_BASE_URL` 和 `LLM_MODEL`。

服务不会主动截断对话历史；历史记录保存在进程内存中，重启服务后清空。

示例：

```dotenv
QQ_APP_ID=your-qq-app-id
QQ_CLIENT_SECRET=your-qq-client-secret
QQ_INTENTS=33554432

LLM_API_KEY=your-llm-api-key
LLM_BASE_URL=https://api.deepseek.com
LLM_MODEL=deepseek-chat
SYSTEM_PROMPT=你是一个可靠、简洁的 QQ 私聊助手。请用中文回答，无法确定时明确说明。
HTTP_PORT=3000
```

### 版本更新

已有部署可以在管理菜单中选择“升级 ANeko-Bot”，也可以直接执行：

```bash
sudo bash /opt/qq-llm-agent/deploy/install.sh --upgrade
```

## 项目结构

```text
src/
├── config.mjs       # 环境变量加载与校验
├── index.mjs        # 服务入口、消息处理和健康检查
├── llm.mjs          # OpenAI 兼容 LLM 客户端
├── memory.mjs       # 按用户隔离的完整进程内会话记忆
├── qq-api.mjs       # QQ Access Token 和 C2C REST API
└── qq-gateway.mjs   # QQ Gateway WebSocket、心跳和 Resume
deploy/
├── install.sh             # Ubuntu/Debian 一键部署脚本
└── qq-llm-agent.service  # systemd 服务配置
.env.example         # 环境变量模板
package.json         # 项目元数据与运行命令
LICENSE              # MIT 许可证
```

## 源码与许可

| 项目 | 地址 |
| --- | --- |
| 源码仓库 | [AMahiru85/ANeko-Bot](https://github.com/AMahiru85/ANeko-Bot) |
| QQ 官方机器人文档 | [bot.q.qq.com](https://bot.q.qq.com/wiki/develop/api-v2/) |
| 许可证 | [MIT](LICENSE) |
