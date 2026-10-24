const TOKEN_URL = "https://api.bot.qq.com/app/getAppAccessToken";
export class QQApi {
  constructor({ appId, clientSecret, apiBase, gatewayUrl }) {
    this.appId = appId;
    this.clientSecret = clientSecret;
    this.apiBase = apiBase.replace(/\/$/, "");
    this.gatewayUrl = gatewayUrl;
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  async getAccessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;

    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: this.appId,
        clientSecret: this.clientSecret,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token) {
      throw new Error(`QQ token request failed (${response.status}): ${JSON.stringify(body)}`);
    }

    this.token = body.access_token;
    const expiresIn = Number(body.expires_in) || 7_200;
    this.tokenExpiresAt = Date.now() + Math.max(60, expiresIn - 300) * 1_000;
    return this.token;
  }

  async request(path, options = {}) {
    const token = await this.getAccessToken();
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", `QQBot ${token}`);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    let response = await fetch(`${this.apiBase}${path}`, {
      ...options,
      headers,
      signal: options.signal || AbortSignal.timeout(15_000),
    });

    if (response.status === 401) {
      this.token = null;
      this.tokenExpiresAt = 0;
      const retryToken = await this.getAccessToken();
      headers.set("Authorization", `QQBot ${retryToken}`);
      response = await fetch(`${this.apiBase}${path}`, {
        ...options,
        headers,
        signal: options.signal || AbortSignal.timeout(15_000),
      });
    }

    return response;
  }

  async getGatewayUrl() {
    if (this.gatewayUrl) return this.gatewayUrl;

    const response = await this.request("/gateway");
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.err_code || !body.url) {
      throw new Error(`QQ gateway request failed (${response.status}): ${JSON.stringify(body)}`);
    }
    return body.url;
  }

  async sendC2CMessage(openid, content, msgId) {
    const response = await this.request(`/v2/users/${encodeURIComponent(openid)}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: content.slice(0, 2000),
        msg_type: 0,
        msg_id: msgId,
        msg_seq: 1,
      }),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.err_code) {
      throw new Error(`QQ C2C reply failed (${response.status}): ${JSON.stringify(body)}`);
    }
    return body;
  }

  async getGatewayToken() {
    return this.getAccessToken();
  }
}
