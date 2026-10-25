function responseError(status, body) {
  const detail = body?.error?.message || JSON.stringify(body);
  return new Error(`LLM API ${status}: ${detail}`);
}

export class LlmClient {
  constructor({ apiKey, baseUrl, model, systemPrompt }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.systemPrompt = systemPrompt;
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
      stream: true,
    };

    if (reasoningEffort) {
      body.reasoning_effort = reasoningEffort;
    } else {
      body.temperature = 0.7;
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
    const response = await fetch(`${this.baseUrl}/chat/completions`, this.buildRequest(history, options));
    const contentType = (response.headers?.get?.("content-type") || "").toLowerCase();

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw responseError(response.status, body);
    }

    // Some OpenAI-compatible providers ignore stream=true and return one JSON response.
    if (!contentType.includes("text/event-stream")) {
      const body = await response.json().catch(() => ({}));
      const content = body?.choices?.[0]?.message?.content;
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
}
