import { estimateTokens } from '../models.mjs';

// Open weights on our own GPUs, bought from instanceOS compute (~/instanceos) the way any other
// customer buys them: a prepaid token bundle, spent down request by request. When a bundle runs out,
// buy the next one. When compute wants payment for it, that is the same x402 charge every Instance
// product raises, so this provider is unavailable until this deployment can pay it.
//
// Compute's contract (its README): POST /v1/bundles {model, tokens} answers 201 with a bundleToken, or
// 402 when the bundle must be paid for first; POST /v1/inference/chat {bundle, messages, model,
// maxTokens} with the bundle token as a bearer spends it down.
export class InstanceComputeProvider {
  #baseUrl; #fetch; #bundleTokens;
  constructor({ baseUrl, bundleTokens = 100_000, fetchImpl = fetch }) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#bundleTokens = bundleTokens;
    this.#fetch = fetchImpl;
    this.bundles = new Map(); // model -> { id, token }
  }

  async #buy(model) {
    const response = await this.#fetch(`${this.#baseUrl}/v1/bundles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, tokens: this.#bundleTokens }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (response.status === 402) {
      // Compute wants paying. Roster has no wallet of its own yet, so this is a stop, not a retry:
      // see "Owner decisions" in DESIGN.md.
      throw Object.assign(
        new Error(`instanceOS compute wants payment for a ${model} bundle: ${body.bundle?.payUrl ?? 'no pay url'}`),
        { code: 'provider_unpaid' },
      );
    }
    if (!response.ok) {
      throw Object.assign(new Error(`could not buy a ${model} bundle: HTTP ${response.status} ${text.slice(0, 200)}`), { code: 'provider_failed' });
    }
    const bundle = { id: body.bundle.id, token: body.bundle.bundleToken };
    this.bundles.set(model, bundle);
    return bundle;
  }

  async chat({ model, system, messages, maxOutputTokens, retried = false }) {
    const bundle = this.bundles.get(model) ?? await this.#buy(model);
    const response = await this.#fetch(`${this.#baseUrl}/v1/inference/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bundle.token}` },
      body: JSON.stringify({
        bundle: bundle.id, model, maxTokens: maxOutputTokens,
        messages: [...(system ? [{ role: 'system', content: system }] : []), ...messages],
      }),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (response.status === 402 || body?.error?.code === 'bundle_spent') {
      if (retried) throw Object.assign(new Error(`${model}: bundle spent and the next one could not be used`), { code: 'provider_failed' });
      this.bundles.delete(model);
      return this.chat({ model, system, messages, maxOutputTokens, retried: true });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`${model} failed: HTTP ${response.status} ${text.slice(0, 300)}`), { code: 'provider_failed' });
    }
    const usage = body.usage ?? {};
    const counted = usage.counted === 'server' || usage.counted === 'provider' ? 'provider' : 'estimated';
    return {
      text: body.content ?? '',
      usage: {
        inputTokens: usage.promptTokens ?? estimateTokens([system ?? '', ...messages.map((m) => m.content)].join(' ')),
        outputTokens: usage.completionTokens ?? estimateTokens(body.content ?? ''),
        counted,
      },
      finishReason: null,
    };
  }
}
