// "Any model" means any model this deployment has both a credential and a declared tier for. The tier
// is in the SKU, so it is what the owner prices: a model with no tier is not for sale, because a price
// we cannot key is a price we would have to invent.
export const TIERS = ['open', 'small', 'mid', 'frontier'];

// The only models named in code, because they are the only ones this session can state exist today.
// Everything else is declared by the operator through ROSTER_MODELS.
const BUILT_IN_TIERS = {
  'anthropic/claude-opus-5': 'frontier',
  'anthropic/claude-sonnet-5': 'mid',
  'anthropic/claude-haiku-4-5-20251001': 'small',
};

export function parseModelKey(key) {
  const slash = (key ?? '').indexOf('/');
  if (slash <= 0 || slash === key.length - 1) {
    throw Object.assign(new Error(`A model key looks like provider/model, not "${key}"`), { code: 'invalid_request' });
  }
  return { provider: key.slice(0, slash), model: key.slice(slash + 1) };
}

export class ModelRouter {
  #providers; #tiers;
  constructor({ providers = {}, extraModels = [] } = {}) {
    this.#providers = providers;
    this.#tiers = new Map(Object.entries(BUILT_IN_TIERS));
    for (const entry of extraModels) {
      const [key, tier] = entry.split('=').map((s) => s.trim());
      if (!key || !TIERS.includes(tier)) {
        throw new Error(`ROSTER_MODELS entries look like provider/model=tier with tier one of ${TIERS.join(', ')}; got "${entry}"`);
      }
      parseModelKey(key);
      this.#tiers.set(key, tier);
    }
  }

  keys() { return [...this.#tiers.keys()]; }
  tierOf(key) { return this.#tiers.get(key) ?? null; }

  // Every declared model with whether it can be hired here and, when it cannot, why. Nothing is sold
  // that would fail on the first call.
  list() {
    return this.keys().map((key) => {
      const { provider, model } = parseModelKey(key);
      const backend = this.#providers[provider];
      return {
        key, provider, model, tier: this.#tiers.get(key),
        available: Boolean(backend),
        unavailableReason: backend ? null : `this deployment has no credential for ${provider}`,
      };
    });
  }

  resolve(key) {
    const tier = this.#tiers.get(key);
    if (!tier) {
      throw Object.assign(new Error(`${key} is not a model this deployment sells. GET /v1/models lists what is.`), { code: 'invalid_request' });
    }
    const { provider, model } = parseModelKey(key);
    const backend = this.#providers[provider];
    if (!backend) {
      throw Object.assign(new Error(`${key} needs a ${provider} credential this deployment does not have`), { code: 'model_unavailable' });
    }
    return { key, tier, provider, model, backend };
  }

  async run({ key, system, messages, maxOutputTokens }) {
    const { model, backend } = this.resolve(key);
    return backend.chat({ model, system, messages, maxOutputTokens });
  }
}

// Four characters to a token is the usual rule of thumb. It is an estimate, and it is only ever used
// to refuse a brief that cannot fit its budget, never to bill for one.
export function estimateTokens(text) { return Math.ceil((text ?? '').length / 4); }
