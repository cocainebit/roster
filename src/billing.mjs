// The only place that talks money. It speaks the platform's service-client contract (~/platform
// SPEC.md 0.2.1): ask for a charge, get either "free" or a charge to pay, then poll until it is paid.
// There is no balance anywhere, so a hire is prepaid and nothing runs before the charge is paid.
export class PaymentUnavailable extends Error {
  constructor(message, options) { super(message, options); this.name = 'PaymentUnavailable'; this.code = 'payment_unavailable'; }
}
export class BillingError extends Error {
  constructor(message, code, status) { super(message); this.name = 'BillingError'; this.code = code; this.status = status; }
}

export class PlatformBilling {
  #baseUrl; #secret; #fetch; #priced = new Set(); #pricesAt = null;
  constructor({ baseUrl, secret, fetchImpl = fetch }) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#secret = secret;
    this.#fetch = fetchImpl;
  }

  async #call(path, { method = 'GET', body, idempotencyKey } = {}) {
    const headers = { Authorization: `Bearer ${this.#secret}` };
    if (body) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
      });
    } catch (cause) {
      throw new PaymentUnavailable(`Payment service unreachable at ${this.#baseUrl}`, { cause });
    }
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (response.ok) return data;
    // A priced SKU on a server with no payment networks is 503: that action genuinely cannot be paid
    // for there, which must never be mistaken for free.
    if (response.status === 503) throw new PaymentUnavailable(data?.error?.message ?? 'Payments are not configured');
    throw new BillingError(data?.error?.message ?? `HTTP ${response.status}`, data?.error?.code ?? 'billing_failed', response.status);
  }

  async openCharge({ sku, units, subject, description, idempotencyKey, expiresInSeconds, organizationId, userId }) {
    return this.#call('/internal/v1/charges', {
      method: 'POST', idempotencyKey,
      body: { sku, units, subject, description, expiresInSeconds, organizationId, userId },
    });
  }

  async getCharge(id) { return this.#call(`/internal/v1/charges/${encodeURIComponent(id)}`); }
  async prices() { return this.#call('/internal/v1/prices'); }

  // Read the price list before asking for a charge, so unpriced work never creates one.
  async isPriced(sku) {
    const fresh = this.#pricesAt !== null && Date.now() - this.#pricesAt < 60_000;
    if (!fresh) {
      const { prices } = await this.prices();
      this.#priced = new Set(prices.filter((p) => p.unitPriceMicro > 0).map((p) => p.sku));
      this.#pricesAt = Date.now();
    }
    return this.#priced.has(sku);
  }

  // The x402 challenge for a charge, taken from the payment service verbatim. The buyer signs what
  // the chain will be asked to accept, so rewriting these requirements into a prettier shape would
  // invalidate the signature. See "Standards" in DESIGN.md for the v1/v2 divergence this preserves.
  async challenge(paymentUrl) {
    let response;
    try {
      response = await this.#fetch(paymentUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) });
    } catch (cause) {
      throw new PaymentUnavailable(`Payment service unreachable at ${paymentUrl}`, { cause });
    }
    return decodeChallenge(response.headers.get('PAYMENT-REQUIRED'));
  }

  // Forward a buyer's signed x402 payload to the payment service, which verifies, settles and
  // confirms on its own RPC. We never see a key and never settle anything ourselves.
  async submitPayment(paymentUrl, payload) {
    let response;
    try {
      response = await this.#fetch(paymentUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'PAYMENT-SIGNATURE': encodePayload(payload) },
        signal: AbortSignal.timeout(60000),
      });
    } catch (cause) {
      throw new PaymentUnavailable(`Payment service unreachable at ${paymentUrl}`, { cause });
    }
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    return {
      status: response.status,
      charge: body.charge ?? null,
      error: body.error ?? null,
      settled: decodeSettle(response.headers.get('PAYMENT-RESPONSE')),
    };
  }
}

// x402 v2 carries these as base64 JSON in HTTP headers. One function each way, no dependency.
export function decodeChallenge(header) {
  if (!header) return null;
  try { return JSON.parse(Buffer.from(header, 'base64').toString('utf8')); } catch { return null; }
}
export function decodeSettle(header) {
  if (!header) return null;
  try { return JSON.parse(Buffer.from(header, 'base64').toString('utf8')); } catch { return null; }
}
export function encodePayload(payload) {
  return typeof payload === 'string' ? payload : Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

// Used by tests and by a machine with no platform running. Free by default, priced when a test says so.
export class FakeBilling {
  constructor({ prices = {}, publicUrl = 'http://127.0.0.1:8760' } = {}) {
    // Named priceList, not prices: a field called prices would shadow the prices() method this class
    // has to answer, and a caller reading the price list would get a TypeError instead of a list.
    this.priceList = prices; this.publicUrl = publicUrl;
    this.charges = new Map(); this.byKey = new Map(); this.calls = []; this.payments = [];
    this.down = false;
  }
  #view(charge) {
    return { charge, payUrl: `${this.publicUrl}/pay/${charge.id}`, paymentUrl: `${this.publicUrl}/v1/charges/${charge.id}/pay` };
  }
  #assertUp() { if (this.down) throw new PaymentUnavailable('Payment service unreachable (test)'); }
  async openCharge({ sku, units, subject, description, idempotencyKey, expiresInSeconds }) {
    this.#assertUp();
    this.calls.push({ sku, units, subject, idempotencyKey, expiresInSeconds });
    if (this.byKey.has(idempotencyKey)) return { ...this.#view(this.charges.get(this.byKey.get(idempotencyKey))), created: false };
    const unitPrice = this.priceList[sku];
    if (unitPrice === undefined) return { free: true };
    const charge = {
      id: `chg_${this.charges.size + 1}`, service: 'roster', sku, units, subject, description,
      amountMicro: unitPrice * units, status: 'open', payer: null,
    };
    this.charges.set(charge.id, charge);
    this.byKey.set(idempotencyKey, charge.id);
    return { ...this.#view(charge), created: true };
  }
  async getCharge(id) {
    this.#assertUp();
    const charge = this.charges.get(id);
    if (!charge) throw new BillingError('not found', 'not_found', 404);
    return this.#view(charge);
  }
  async prices() { this.#assertUp(); return { prices: Object.entries(this.priceList).map(([sku, unitPriceMicro]) => ({ sku, unitPriceMicro })) }; }
  async isPriced(sku) { this.#assertUp(); return this.priceList[sku] !== undefined; }
  async challenge(paymentUrl) {
    this.#assertUp();
    const id = paymentUrl.split('/').at(-2);
    const charge = this.charges.get(id);
    return {
      x402Version: 2,
      resource: { url: paymentUrl, description: charge?.description ?? '', mimeType: 'application/json' },
      accepts: [{ scheme: 'exact', network: 'eip155:84532', asset: '0xtest', amount: String(charge?.amountMicro ?? 0), payTo: '0xhouse', maxTimeoutSeconds: 600 }],
    };
  }
  async submitPayment(paymentUrl, payload) {
    this.#assertUp();
    const id = paymentUrl.split('/').at(-2);
    const charge = this.charges.get(id);
    this.payments.push({ id, payload });
    if (!charge) return { status: 404, charge: null, error: { code: 'not_found', message: 'no such charge' }, settled: null };
    if (payload?.bad) {
      return { status: 402, charge, error: { code: 'payment_required', message: 'signature did not verify' }, settled: { success: false, errorReason: 'INVALID_SIGNATURE', network: 'eip155:84532' } };
    }
    charge.status = 'paid';
    charge.payer = payload?.payer ?? '0xpayer';
    return { status: 200, charge, error: null, settled: { success: true, transaction: '0xtx', network: 'eip155:84532', payer: charge.payer } };
  }
  // Test helper: stand in for a person paying the sheet, rather than an agent paying over x402.
  pay(id, payer = '0xpayer') {
    const charge = this.charges.get(id);
    if (!charge) throw new Error('no such charge');
    charge.status = 'paid'; charge.payer = payer;
    return charge;
  }
  expire(id) {
    const charge = this.charges.get(id);
    if (!charge) throw new Error('no such charge');
    charge.status = 'expired';
    return charge;
  }
}

// Development only: no charges, every hire free. The server says so on /healthz and at startup,
// because an unmetered service that ships by accident is a business hole, not a bug.
export class UnmeteredBilling {
  async openCharge() { return { free: true }; }
  async getCharge() { throw new BillingError('no charges exist in unmetered mode', 'not_found', 404); }
  async prices() { return { prices: [] }; }
  async isPriced() { return false; }
  async challenge() { return null; }
  async submitPayment() { throw new BillingError('no charges exist in unmetered mode', 'not_found', 404); }
}
