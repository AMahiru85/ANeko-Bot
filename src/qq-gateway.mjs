export class QQGateway {
  constructor({ api, intents, onEvent, onError }) {
    this.api = api;
    this.intents = intents;
    this.onEvent = onEvent;
    this.onError = onError;
    this.socket = null;
    this.sequence = null;
    this.sessionId = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.stopped = false;
    this.reconnectDelay = 1_000;
  }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);
    this.socket?.close();
  }

  async connect() {
    if (this.stopped) return;

    try {
      const gatewayUrl = await this.api.getGatewayUrl();
      const token = await this.api.getGatewayToken();
      const socket = new WebSocket(gatewayUrl);
      this.socket = socket;

      socket.onopen = () => {
        this.reconnectDelay = 1_000;
        console.log(`[QQ] connected to ${gatewayUrl}`);
      };

      socket.onmessage = async (event) => {
        try {
          const frame = await decodeFrame(event.data);
          await this.handleFrame(frame, token);
        } catch (error) {
          this.reportError(error);
        }
      };

      socket.onerror = () => {
        this.reportError(new Error("QQ Gateway WebSocket error"));
      };

      socket.onclose = () => {
        clearInterval(this.heartbeatTimer);
        this.socket = null;
        if (!this.stopped) this.scheduleReconnect();
      };
    } catch (error) {
      this.reportError(error);
      this.scheduleReconnect();
    }
  }

  async handleFrame(frame, token) {
    if (frame.s !== undefined && frame.s !== null) this.sequence = frame.s;

    switch (frame.op) {
      case 0:
        if (frame.t === "READY") this.sessionId = frame.d?.session_id || this.sessionId;
        await this.onEvent(frame.t, frame.d);
        break;
      case 7:
        this.socket?.close();
        break;
      case 9:
        this.reportError(new Error("QQ Gateway rejected the session; reconnecting"));
        this.sessionId = null;
        this.sequence = null;
        this.socket?.close();
        break;
      case 10:
        this.startHeartbeat(frame.d?.heartbeat_interval);
        if (this.sessionId && this.sequence !== null) {
          this.send({
            op: 6,
            d: {
              token: `QQBot ${token}`,
              session_id: this.sessionId,
              seq: this.sequence,
            },
          });
        } else {
          this.send({
            op: 2,
            d: {
              token: `QQBot ${token}`,
              intents: this.intents,
              shard: [0, 1],
              properties: {
                "$os": "linux",
                "$browser": "qq-deepseek-agent",
                "$device": "qq-deepseek-agent",
              },
            },
          });
        }
        break;
      case 11:
        break;
      default:
        break;
    }
  }

  startHeartbeat(interval) {
    clearInterval(this.heartbeatTimer);
    if (!Number.isFinite(interval) || interval <= 0) return;
    this.heartbeatTimer = setInterval(() => {
      this.send({ op: 1, d: this.sequence });
    }, interval);
  }

  send(frame) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
    }
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
    console.log(`[QQ] reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  reportError(error) {
    if (this.onError) this.onError(error);
    else console.error(error);
  }
}

async function decodeFrame(data) {
  if (typeof data === "string") return JSON.parse(data);
  if (data instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(data));
  if (ArrayBuffer.isView(data)) return JSON.parse(new TextDecoder().decode(data));
  if (data && typeof data.text === "function") return JSON.parse(await data.text());
  throw new Error("Unsupported QQ Gateway frame type");
}
