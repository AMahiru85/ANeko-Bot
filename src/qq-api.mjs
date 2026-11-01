export class QQApi {
  constructor({ appId, clientSecret, authBase, apiBase, gatewayUrl }) {
    this.appId = appId;
    this.clientSecret = clientSecret;
    this.authBase = (authBase || "https://api.bot.qq.com").replace(/\/$/, "");
    this.apiBase = (apiBase || "https://api.bot.qq.com").replace(/\/$/, "");
    this.gatewayUrl = gatewayUrl;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.tokenPromise = null;
  }

  async getAccessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt) return this.token;
    if (this.tokenPromise) return this.tokenPromise;

    this.tokenPromise = (async () => {
      const response = await fetch(`${this.authBase}/app/getAppAccessToken`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId: this.appId, clientSecret: this.clientSecret }),
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
    })();

    try {
      return await this.tokenPromise;
    } finally {
      this.tokenPromise = null;
    }
  }

  async request(path, options = {}) {
    const send = async (token) => {
      const headers = new Headers(options.headers || {});
      headers.set("Authorization", `QQBot ${token}`);
      if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      return fetch(`${this.apiBase}${path}`, {
        ...options,
        headers,
        signal: options.signal || AbortSignal.timeout(15_000),
      });
    };

    let response = await send(await this.getAccessToken());

    if (response.status === 401) {
      this.token = null;
      this.tokenExpiresAt = 0;
      response = await send(await this.getAccessToken());
    }

    return response;
  }

  async getGatewayUrl() {
    if (this.gatewayUrl) return this.gatewayUrl;

    let response = await this.request("/gateway/bot");
    if (response.status === 404) response = await this.request("/gateway");
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.err_code || body.code || !body.url) {
      throw new Error(`QQ gateway request failed (${response.status}): ${JSON.stringify(body)}`);
    }
    return body.url;
  }

  async sendC2CMessage(openid, content, msgId, msgSeq = 1, eventId) {
    const payload = {
      content: content.slice(0, 1_800),
      msg_type: 0,
      msg_seq: msgSeq,
    };
    if (eventId) payload.event_id = eventId;
    else if (msgId) payload.msg_id = msgId;
    const response = await this.request(`/v2/users/${encodeURIComponent(openid)}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.err_code || body.code) {
      throw new Error(`QQ C2C reply failed (${response.status}): ${JSON.stringify(body)}`);
    }
    return body;
  }

  async sendGroupMessage(groupOpenid, content, msgId, msgSeq = 1, eventId) {
    const payload = {
      content: content.slice(0, 1_800),
      msg_type: 0,
      msg_seq: msgSeq,
    };
    if (eventId) payload.event_id = eventId;
    else if (msgId) payload.msg_id = msgId;
    const response = await this.request(`/v2/groups/${encodeURIComponent(groupOpenid)}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.err_code || body.code) throw new Error(`QQ group reply failed (${response.status}): ${JSON.stringify(body)}`);
    return body;
  }

  async sendChannelMessage(channelId, content, msgId) {
    const payload = { content: content.slice(0, 1_800), ...(msgId ? { msg_id: msgId } : {}) };
    const response = await this.request(`/channels/${encodeURIComponent(channelId)}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.err_code || body.code) throw new Error(`QQ channel reply failed (${response.status}): ${JSON.stringify(body)}`);
    return body;
  }

  async sendDirectMessage(guildId, content, msgId) {
    const payload = { content: content.slice(0, 1_800), ...(msgId ? { msg_id: msgId } : {}) };
    const response = await this.request(`/dms/${encodeURIComponent(guildId)}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.err_code || body.code) throw new Error(`QQ direct message reply failed (${response.status}): ${JSON.stringify(body)}`);
    return body;
  }

  async sendC2CMarkdown(openid, content, keyboard, { msgId, eventId } = {}) {
    const payload = {
      msg_type: 2,
      markdown: { content: content.slice(0, 1_800) },
      keyboard,
      msg_seq: 1,
    };
    if (eventId) payload.event_id = eventId;
    else if (msgId) payload.msg_id = msgId;

    const response = await this.request(`/v2/users/${encodeURIComponent(openid)}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.err_code || body.code) {
      throw new Error(`QQ C2C Markdown reply failed (${response.status}): ${JSON.stringify(body)}`);
    }
    return body;
  }

  async respondInteraction(interactionId, code = 0) {
    const response = await this.request(`/interactions/${encodeURIComponent(interactionId)}`, {
      method: "PUT",
      body: JSON.stringify({ code }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(`QQ interaction response failed (${response.status}): ${JSON.stringify(body)}`);
    }
  }

  async sendC2CStreamMessage(openid, content, msgId, streamMsgId, inputState, index = 0) {
    const payload = {
      input_mode: "replace",
      input_state: inputState,
      index,
      content_type: "text",
      content_raw: content.slice(0, 1_800),
      msg_id: msgId,
      msg_seq: 1,
    };
    if (streamMsgId) payload.stream_msg_id = streamMsgId;

    const response = await this.request(`/v2/users/${encodeURIComponent(openid)}/stream_messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.err_code || body.code) {
      throw new Error(`QQ C2C stream reply failed (${response.status}): ${JSON.stringify(body)}`);
    }

    return {
      ...body,
      streamMsgId: body.stream_msg_id || body.id || body.message_id || streamMsgId || "",
    };
  }

}
