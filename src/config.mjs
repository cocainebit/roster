// Every setting the service reads, in one place. Ports come from the block this repo owns (8810-8819).
export function loadConfig(env = process.env) {
  const int = (name, fallback) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
    return n;
  };
  const list = (name, fallback = []) => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  };
  return {
    port: int('ROSTER_PORT', 8810),
    publicUrl: (env.ROSTER_PUBLIC_URL ?? 'http://127.0.0.1:8810').replace(/\/+$/, ''),

    // The shared account and payment service (achi-a5's ~/platform). Local and testnet only.
    platformUrl: env.PLATFORM_URL ?? 'http://127.0.0.1:8760',
    platformSecret: env.PLATFORM_SERVICE_SECRET ?? '',
    // 'platform' raises a charge for every hire. 'unmetered' gives the work away and exists only so a
    // developer with no service token can run something here. It is never a default.
    billing: env.ROSTER_BILLING ?? 'platform',
    // A hire is paid before work starts, so a payer who vanishes costs us nothing. This is how long
    // they have to pay before the hire expires.
    payWindowSeconds: int('ROSTER_PAY_WINDOW_SECONDS', 900),
    // If the payment service cannot be reached, work already paid for keeps going for this long
    // before it stops. A new hire is refused outright, because nothing is lost by not starting it.
    billingGraceSeconds: int('ROSTER_BILLING_GRACE_SECONDS', 300),

    // Model access. A provider with no key is unavailable rather than sold: every catalog entry says
    // which of its models this deployment can actually run.
    anthropicKey: env.ANTHROPIC_API_KEY ?? '',
    anthropicUrl: env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
    openaiKey: env.OPENAI_API_KEY ?? '',
    openaiUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com',
    googleKey: env.GOOGLE_API_KEY ?? '',
    googleUrl: env.GOOGLE_BASE_URL ?? 'https://generativelanguage.googleapis.com',
    // The breadth backend: one key, hundreds of models, any of them hireable once the operator
    // declares the tier it bills under (see ROSTER_MODELS).
    openrouterKey: env.OPENROUTER_API_KEY ?? '',
    openrouterUrl: env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api',
    // Open weights on our own GPUs, through instanceOS compute (~/instanceos, OpenAI-compatible).
    instanceUrl: env.ROSTER_INSTANCE_URL ?? '',
    instanceKey: env.ROSTER_INSTANCE_KEY ?? '',
    // Extra models this deployment sells, as key=tier pairs, e.g.
    // ROSTER_MODELS=openrouter/openai/gpt-5=frontier,instance/llama70b=open
    extraModels: list('ROSTER_MODELS'),

    // Anyone may list an agent for hire. A listing is a prompt plus a model allowlist, so it is model
    // access under another name: keep the cap low and read "Abuse" in DESIGN.md before raising it.
    publishing: env.ROSTER_PUBLISHING === 'off' ? 'off' : 'on',
    maxPublishedPerOrg: int('ROSTER_MAX_PUBLISHED_PER_ORG', 10),
    publishedTiers: list('ROSTER_PUBLISHED_TIERS', ['open', 'small', 'mid']),

    // Ceilings. Prepayment stops a chargeback; it does nothing about someone renting the hall to run a
    // jailbreak farm or to burn our model key, which is what these are for.
    maxConcurrentHires: int('ROSTER_MAX_CONCURRENT_HIRES', 10),
    maxConcurrentPerOrg: int('ROSTER_MAX_CONCURRENT_PER_ORG', 3),
    maxAwaitingPaymentPerOrg: int('ROSTER_MAX_AWAITING_PER_ORG', 20),
    maxTurns: int('ROSTER_MAX_TURNS', 8),
    maxRequestBytes: int('ROSTER_MAX_REQUEST_BYTES', 1_048_576),
    taskSeconds: int('ROSTER_TASK_SECONDS', 600),

    // Where hires are remembered across a restart. Empty disables persistence (tests do this).
    stateFile: env.ROSTER_STATE_FILE ?? '.state/roster.json',
    // The operator console reads every hire on the deployment, which is more than any hire token
    // grants, so it has its own key and is off without one.
    adminToken: env.ROSTER_ADMIN_TOKEN ?? '',
  };
}
