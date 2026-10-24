# QQ 官方机器人 + DeepSeek 私聊 Agent

这是一个 Node.js 服务，使用 QQ 官方机器人 Gateway 接收 `C2C_MESSAGE_CREATE` 私聊事件，调用 DeepSeek，再通过 QQ 官方 API 回复。服务不需要 NapCat、个人 QQ 登录或额外的 Node 运行时依赖。

QQ 官方也提供 `qq-guild-bot` Node SDK；本项目直接使用官方 API 和 Gateway 协议，采用当前文档的 `AppSecret + Access Token` 鉴权，并把 C2C 私聊事件、断线 Resume 和消息去重放在代码中，便于部署和排错。

## 1. QQ 开放平台配置

1. 在 [QQ 开放平台](https://q.qq.com/) 创建机器人，获取 `AppID` 和 `ClientSecret`。
2. 在事件订阅中开启 C2C 私聊消息事件，并按平台页面要求配置消息权限/Intent。
3. 将测试账号加入可用范围。官方机器人通常只能给平台允许的测试用户或已建立会话的用户回复。

模板中的 `QQ_INTENTS=33554432` 是 C2C 事件常用值；如果开放平台页面显示了不同的 Intent 数值，以平台页面为准。

## 2. 本地运行

要求 Node.js 22.4 或更高版本（使用内置 `fetch` 和 WebSocket）。

```bash
cp .env.example .env
编辑 .env，填写 QQ_APP_ID、QQ_CLIENT_SECRET、DEEPSEEK_API_KEY
node src/index.mjs
```

健康检查：

```bash
curl http://127.0.0.1:3000/health
```

向机器人发送 `/reset` 或 `/clear` 可以清除该用户的短期对话记忆。当前记忆保存在进程内存中，重启后清空。

## 3. Linux systemd 部署

```bash
sudo useradd --system --home /opt/qq-deepseek-agent --shell /usr/sbin/nologin qqbot
sudo mkdir -p /opt/qq-deepseek-agent
sudo cp -r . /opt/qq-deepseek-agent/
sudo chown -R qqbot:qqbot /opt/qq-deepseek-agent
sudo chmod 600 /opt/qq-deepseek-agent/.env
sudo cp deploy/qq-deepseek-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qq-deepseek-agent
sudo journalctl -u qq-deepseek-agent -f
```

服务只需要主动访问 QQ 和 DeepSeek 的 HTTPS/WSS 地址，不需要公网开放端口。`HTTP_PORT` 仅监听 `127.0.0.1`，用于本机健康检查。

## 4. DeepSeek 配置

默认配置使用：

```dotenv
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
```

如需切换模型，只修改 `.env`，不需要改代码。API Key 只放在服务器 `.env` 中，不要提交到 Git。
