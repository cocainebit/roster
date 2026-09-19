import { estimateTokens } from '../models.mjs';

// Any OpenAI-compatible server: OpenAI itself, OpenRouter (which is how one key reaches hundreds of
// models), vLLM, LiteLLM, llama.cpp. One protocol, several providers.
export class OpenAICompatibleProvider {
  #baseUrl; #key; #fetch; #extraHeaders;
  constructor({ baseUrl, apiKey = '', fetchImpl = fetch, headers = {} }) {
    this.#baseUrl = baseUrl.replace(/\/+$/, ''); this.#key = apiKey; this.#fetch = fetchImpl; this.#extraHeaders = headers;
  }

  async chat({ model, system, messages, maxOutputTokens }) {
    const body = {
      model,
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
      max_tokens: maxOutputTokens,
    };
    const response = await this.#fetch(`${this.#baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(this.#key ? { Authorization: `Bearer ${this.#key}` } : {}), ...this.#extraHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error(`${model} failed: HTTP ${response.status} ${text.slice(0, 300)}`), { code: 'provider_failed' });
    }
    const parsed = JSON.parse(text);
    const content = parsed.choices?.[0]?.message?.content ?? '';
    const usage = parsed.usage ?? {};
    // Prefer what the server counted. Where a server reports nothing, say the count is an estimate
    // rather than presenting a guess as a measurement.
    const counted = usage.prompt_tokens !== undefined && usage.completion_tokens !== undefined ? 'provider' : 'estimated';
    return {
      text: content,
      usage: {
        inputTokens: usage.prompt_tokens ?? estimateTokens([system ?? '', ...messages.map((m) => m.content)].join(' ')),
        outputTokens: usage.completion_tokens ?? estimateTokens(content),
        counted,
      },
      finishReason: parsed.choices?.[0]?.finish_reason ?? null,
    };
  }
}
