import { estimateTokens } from '../models.mjs';

// Anthropic's Messages API. The system prompt is its own field rather than a message, and usage comes
// back as input_tokens / output_tokens.
export class AnthropicProvider {
  #baseUrl; #key; #fetch; #version;
  constructor({ baseUrl = 'https://api.anthropic.com', apiKey, fetchImpl = fetch, version = '2023-06-01' }) {
    this.#baseUrl = baseUrl.replace(/\/+$/, ''); this.#key = apiKey; this.#fetch = fetchImpl; this.#version = version;
  }

  async chat({ model, system, messages, maxOutputTokens }) {
    const response = await this.#fetch(`${this.#baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': this.#key, 'anthropic-version': this.#version },
      body: JSON.stringify({
        model, max_tokens: maxOutputTokens,
        ...(system ? { system } : {}),
        messages: messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error(`${model} failed: HTTP ${response.status} ${text.slice(0, 300)}`), { code: 'provider_failed' });
    }
    const parsed = JSON.parse(text);
    const content = (parsed.content ?? []).filter((block) => block.type === 'text').map((block) => block.text).join('');
    const usage = parsed.usage ?? {};
    const counted = usage.input_tokens !== undefined && usage.output_tokens !== undefined ? 'provider' : 'estimated';
    return {
      text: content,
      usage: {
        inputTokens: usage.input_tokens ?? estimateTokens([system ?? '', ...messages.map((m) => m.content)].join(' ')),
        outputTokens: usage.output_tokens ?? estimateTokens(content),
        counted,
      },
      finishReason: parsed.stop_reason ?? null,
    };
  }
}
