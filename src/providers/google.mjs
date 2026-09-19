import { estimateTokens } from '../models.mjs';

// Gemini's generateContent. Roles are "user" and "model", the system prompt is systemInstruction, and
// usage comes back as usageMetadata.
export class GoogleProvider {
  #baseUrl; #key; #fetch;
  constructor({ baseUrl = 'https://generativelanguage.googleapis.com', apiKey, fetchImpl = fetch }) {
    this.#baseUrl = baseUrl.replace(/\/+$/, ''); this.#key = apiKey; this.#fetch = fetchImpl;
  }

  async chat({ model, system, messages, maxOutputTokens }) {
    const url = `${this.#baseUrl}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const response = await this.#fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.#key },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens },
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error(`${model} failed: HTTP ${response.status} ${text.slice(0, 300)}`), { code: 'provider_failed' });
    }
    const parsed = JSON.parse(text);
    const candidate = parsed.candidates?.[0];
    const content = (candidate?.content?.parts ?? []).map((part) => part.text ?? '').join('');
    const usage = parsed.usageMetadata ?? {};
    const counted = usage.promptTokenCount !== undefined && usage.candidatesTokenCount !== undefined ? 'provider' : 'estimated';
    return {
      text: content,
      usage: {
        inputTokens: usage.promptTokenCount ?? estimateTokens([system ?? '', ...messages.map((m) => m.content)].join(' ')),
        outputTokens: usage.candidatesTokenCount ?? estimateTokens(content),
        counted,
      },
      finishReason: candidate?.finishReason ?? null,
    };
  }
}
