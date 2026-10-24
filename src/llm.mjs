export class LlmClient {
  constructor({ apiKey, baseUrl, model, systemPrompt }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.model = model;
    this.systemPrompt = systemPrompt;
  }

  async chat(history) {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: this.systemPrompt },
          ...history,
        ],
        temperature: 0.7,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = body?.error?.message || JSON.stringify(body);
      throw new Error(`LLM API ${response.status}: ${detail}`);
    }

    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("LLM returned an empty response");
    }
    return content.trim();
  }
}
