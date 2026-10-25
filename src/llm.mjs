function responseError(status, body) {
  const detail = body?.error?.message || JSON.stringify(body);
  return new Error(`LLM API ${status}: ${detail}`);
}

export class LlmClient {
  constructor({ apiKey, baseUrl, model, systemPrompt, provider }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.systemPrompt = systemPrompt;
    this.provider = provider || (/api\.deepseek\.com$/i.test(this.baseUrl) ? "deepseek" : "other");
  }

  request(path, options = {}) {
    return fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        ...(options.headers || {}),
      },
      signal: options.signal || AbortSignal.timeout(60_000),
    });
  }

  async parseResponse(response, label = "LLM API") {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw responseError(response.status, body);
    if (body?.error) throw new Error(`${label}: ${body.error.message || JSON.stringify(body.error)}`);
    return body;
  }

  buildRequest(history, options = {}) {
    const model = options.model || this.model;
    const reasoningEffort = options.reasoningEffort && options.reasoningEffort !== "none"
      ? options.reasoningEffort
      : "";
    const body = {
      model,
      messages: [
        ...(this.systemPrompt ? [{ role: "system", content: this.systemPrompt }] : []),
        ...history,
      ],
      stream: options.stream !== undefined ? options.stream : true,
    };

    for (const key of ["tools", "tool_choice", "response_format", "max_tokens", "temperature", "top_p"]) {
      if (options[key] !== undefined) body[key] = options[key];
    }

    if (reasoningEffort) {
      body.reasoning_effort = reasoningEffort;
    } else {
      body.temperature = 0.7;
    }

    if (this.provider === "deepseek") {
      body.thinking = { type: reasoningEffort ? "enabled" : "disabled" };
    }

    return {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    };
  }

  async *stream(history, options = {}) {
    const response = await this.request("/chat/completions", this.buildRequest(history, options));
    const contentType = (response.headers?.get?.("content-type") || "").toLowerCase();

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw responseError(response.status, body);
    }

    // Some OpenAI-compatible providers ignore stream=true and return one JSON response.
    if (!contentType.includes("text/event-stream")) {
      const body = await response.json().catch(() => ({}));
      const message = body?.choices?.[0]?.message;
      const content = message?.content;
      if (typeof content !== "string" || !content.trim()) {
        throw new Error("LLM returned an empty response");
      }
      yield content;
      return;
    }

    if (!response.body) throw new Error("LLM returned an empty stream");

    const decoder = new TextDecoder();
    let buffer = "";
    let received = false;
    let done = false;

    const consumeLine = (line) => {
      if (!line.startsWith("data:")) return null;
      const payload = line.slice(5).trimStart();
      if (payload === "[DONE]") return { done: true };
      if (!payload) return null;

      let event;
      try {
        event = JSON.parse(payload);
      } catch (error) {
        throw new Error(`Invalid LLM stream event: ${error.message}`);
      }
      if (event?.error) throw responseError(response.status, event);

      const delta = event?.choices?.[0]?.delta?.content;
      if (typeof delta !== "string" || !delta) return null;
      received = true;
      return { content: delta };
    };

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const event = consumeLine(line);
        if (!event) continue;
        if (event.done) {
          done = true;
          break;
        }
        yield event.content;
      }
      if (done) break;
    }

    if (!done) {
      buffer += decoder.decode();
      const event = consumeLine(buffer);
      if (event?.content) yield event.content;
      done = event?.done || false;
    }

    if (!received) throw new Error("LLM returned an empty response");
  }

  async chat(history, options = {}) {
    let content = "";
    for await (const delta of this.stream(history, options)) content += delta;
    return content.trim();
  }

  async complete(history, options = {}) {
    const request = this.buildRequest(history, { ...options, stream: false });
    const response = await this.request("/chat/completions", request);
    const payload = await this.parseResponse(response);
    const message = payload?.choices?.[0]?.message;
    if (!message || (typeof message.content !== "string" && !Array.isArray(message.tool_calls))) {
      throw new Error("LLM returned an empty response");
    }
    return message;
  }

  async listModels() {
    if (this.provider !== "deepseek") throw new Error("Model listing is only available for DeepSeek");
    return this.parseResponse(await this.request("/models"), "Model list request failed");
  }

  getModels() {
    return this.listModels();
  }

  async getBalance() {
    if (this.provider !== "deepseek") throw new Error("Balance lookup is only available for DeepSeek");
    return this.parseResponse(await this.request("/user/balance"), "Balance request failed");
  }

  queryBalance() {
    return this.getBalance();
  }

  async uploadFile(file, purpose = "user_data", options = {}) {
    if (this.provider !== "deepseek") throw new Error("Files API is only available for DeepSeek");
    if (purpose !== "user_data") throw new Error("DeepSeek Files API purpose must be user_data");
    const form = new FormData();
    const blob = file instanceof Blob ? file : new Blob([file]);
    form.append("file", blob, options.filename || file?.name || "upload.bin");
    form.append("purpose", purpose);
    if (options.expiresAfter) {
      const { anchor, seconds } = options.expiresAfter;
      if (anchor !== "created_at" || !Number.isInteger(seconds) || seconds < 3_600 || seconds > 2_592_000) {
        throw new Error("DeepSeek file expiry must use created_at and seconds between 3600 and 2592000");
      }
      form.append("expires_after[anchor]", anchor);
      form.append("expires_after[seconds]", String(seconds));
    }
    return this.parseResponse(await this.request("/files", { method: "POST", body: form }), "File upload failed");
  }

  async listFiles(parameters = {}) {
    if (this.provider !== "deepseek") throw new Error("Files API is only available for DeepSeek");
    const query = new URLSearchParams();
    for (const key of ["after", "limit", "order", "purpose"]) {
      if (parameters[key] !== undefined && parameters[key] !== "") query.set(key, String(parameters[key]));
    }
    const suffix = query.toString() ? `?${query}` : "";
    return this.parseResponse(await this.request(`/files${suffix}`), "File list request failed");
  }

  async retrieveFile(fileId) {
    if (this.provider !== "deepseek") throw new Error("Files API is only available for DeepSeek");
    return this.parseResponse(await this.request(`/files/${encodeURIComponent(fileId)}`), "File request failed");
  }

  async deleteFile(fileId) {
    if (this.provider !== "deepseek") throw new Error("Files API is only available for DeepSeek");
    return this.parseResponse(await this.request(`/files/${encodeURIComponent(fileId)}`, { method: "DELETE" }), "File deletion failed");
  }

  async inspectImage(image, prompt = "请分析这张图片。", options = {}) {
    if (this.provider !== "deepseek") throw new Error("Image understanding is only available for DeepSeek");
    const imageBlock = typeof image === "string" && image.startsWith("file-api-")
      ? { type: "file", file_id: image }
      : { type: "image_url", image_url: { url: image, ...(options.detail ? { detail: options.detail } : {}) } };
    const history = [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        imageBlock,
      ],
    }];
    const { detail, ...requestOptions } = options;
    return this.complete(history, requestOptions);
  }

  analyzeImage(image, prompt = "请分析这张图片。", options = {}) {
    return this.inspectImage(image, prompt, options);
  }

  async inspectFile(fileId, prompt = "请分析这个文件。", options = {}) {
    if (this.provider !== "deepseek") throw new Error("File understanding is only available for DeepSeek");
    const history = [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "file", file_id: fileId },
      ],
    }];
    return this.complete(history, options);
  }

  async webSearch(query, options = {}) {
    if (this.provider !== "deepseek") throw new Error("Web search is only available for DeepSeek");
    const endpoint = options.endpoint || `${this.baseUrl}/v1/tools/search`;
    const { endpoint: _endpoint, parameters: nestedParameters, timeoutMs: _timeoutMs, ...directParameters } = options;
    const parameters = { query, ...directParameters, ...(nestedParameters || {}) };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(parameters),
      signal: AbortSignal.timeout(options.timeoutMs || 60_000),
    });
    return this.parseResponse(response, "Web search request failed");
  }

  searchWeb(query, options = {}) {
    return this.webSearch(query, options);
  }

  async crawl(url, options = {}) {
    if (this.provider !== "deepseek") throw new Error("Web fetching is only available for DeepSeek");
    const endpoint = options.endpoint || `${this.baseUrl}/v1/tools/fetch`;
    const { endpoint: _endpoint, parameters: nestedParameters, timeoutMs: _timeoutMs, ...directParameters } = options;
    const parameters = { url, ...directParameters, ...(nestedParameters || {}) };
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(parameters),
      signal: AbortSignal.timeout(options.timeoutMs || 60_000),
    });
    return this.parseResponse(response, "Web crawl request failed");
  }

  fetchWebPage(url, options = {}) {
    return this.crawl(url, options);
  }

  async chatWithTools(history, { tools = [], toolHandler, maxToolRounds = 4, ...options } = {}) {
    if (!tools.length) return { content: await this.chat(history, options), messages: history };
    if (typeof toolHandler !== "function") throw new Error("toolHandler is required when tools are enabled");

    const messages = history.map((message) => ({ ...message }));
    for (let round = 0; round < maxToolRounds; round += 1) {
      const message = await this.complete(messages, {
        ...options,
        tools,
        tool_choice: options.tool_choice || "auto",
      });
      if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
        const content = typeof message.content === "string" ? message.content.trim() : "";
        messages.push({ role: "assistant", content });
        return { content, messages };
      }

      messages.push({ role: "assistant", content: message.content || null, tool_calls: message.tool_calls });
      for (const call of message.tool_calls) {
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || "{}");
        } catch (error) {
          args = { parse_error: error.message };
        }
        let result;
        try {
          result = await toolHandler(call.function?.name, args, call);
        } catch (error) {
          result = { error: error.message };
        }
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: typeof result === "string" ? result : JSON.stringify(result),
        });
      }
    }
    throw new Error("LLM exceeded the maximum tool-call rounds");
  }
}
