import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { estimateTokens } from './models.mjs';
import { skuFor } from './catalog.mjs';
import { PaymentUnavailable } from './billing.mjs';

// Canonical task states are A2A 1.0's (the 0.3 dialect is translated at the wire in a2a.mjs).
export const STATE = {
  submitted: 'TASK_STATE_SUBMITTED',
  working: 'TASK_STATE_WORKING',
  inputRequired: 'TASK_STATE_INPUT_REQUIRED',
  completed: 'TASK_STATE_COMPLETED',
  failed: 'TASK_STATE_FAILED',
  canceled: 'TASK_STATE_CANCELED',
  rejected: 'TASK_STATE_REJECTED',
};
const TERMINAL = new Set([STATE.completed, STATE.failed, STATE.canceled, STATE.rejected]);
export const EXTENSION_URI = 'urn:instance:roster:hire:v1';
export const X402_EXTENSION_URI = 'https://github.com/google-a2a/a2a-x402/v0.1';

export function isTerminal(state) { return TERMINAL.has(state); }

const fail = (message, code, extra = {}) => Object.assign(new Error(message), { code, ...extra });

// The hall. It owns the task state machine, the payment gate, the budget and the caps, with an
// injected clock so every one of those behaviours is tested without waiting for time to pass.
export class Hall {
  #hires = new Map();
  #waiters = new Map();

  constructor({ billing, catalog, models, config, store = null, now = () => Date.now(), newId = () => randomUUID(), newToken = () => randomBytes(24).toString('base64url') }) {
    this.billing = billing; this.catalog = catalog; this.models = models; this.config = config;
    this.store = store; this.now = now; this.newId = newId; this.newToken = newToken;
    this.billingUnavailableSince = null;
    for (const hire of store?.loadAll?.().hires ?? []) {
      // Work cannot resume across a restart: the model call that was in flight is gone. A hire that
      // was working is interrupted, and because it is paid for, resending on it re-runs it free.
      if (hire.state === STATE.working) {
        hire.state = STATE.failed;
        hire.statusText = 'This hire was interrupted by a restart. Send the message again on this task: it is paid for and costs nothing more.';
        hire.retryable = true;
      }
      this.#hires.set(hire.id, hire);
    }
  }

  // ------------------------------------------------------------------ reading

  get(id) {
    const hire = this.#hires.get(id);
    if (!hire) throw fail(`No hire with id ${id}`, 'task_not_found');
    return hire;
  }

  // A task id travels in urls, logs and shell history, so it is not a secret. Reading, continuing or
  // cancelling a hire needs the token handed back once when it was created. Paying needs nothing.
  authorize(id, presented) {
    const hire = this.get(id);
    const expected = Buffer.from(hire.token);
    const given = Buffer.from(presented ?? '');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw fail('That is not the hire token for this task', 'unauthorized');
    }
    return hire;
  }

  list({ contextId = null, state = null, limit = 50 } = {}) {
    return [...this.#hires.values()]
      .filter((h) => (contextId ? h.contextId === contextId : true))
      .filter((h) => (state ? h.state === state : true))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  // ------------------------------------------------------------------- hiring

  async hire({ slug, text = '', data = null, model = null, skill = null, contextId = null, message = null, callerAddress = null, returnImmediately = false, defer = false, parent = null }) {
    const listing = this.catalog.get(slug);
    const chosen = model ?? listing.defaultModel;
    const resolved = this.models.resolve(chosen); // throws invalid_request / model_unavailable
    if (!listing.tiers.includes(resolved.tier)) {
      throw fail(`${listing.name} is not for hire on a ${resolved.tier} model. It takes: ${listing.tiers.join(', ')}.`, 'invalid_request');
    }
    if (skill && !listing.skills.some((s) => s.id === skill)) {
      throw fail(`${listing.name} has no skill "${skill}". It has: ${listing.skills.map((s) => s.id).join(', ')}.`, 'invalid_request');
    }

    const brief = this.#briefFrom({ text, data, message });
    if (!brief.trim()) throw fail('A hire needs a brief: send at least one text or data part', 'invalid_request');
    const budget = parent ? parent.budget : { ...listing.budget };
    const spent = parent ? parent.spent : { inputTokens: 0, outputTokens: 0, counted: null };
    const wanted = estimateTokens(listing.instructions) + estimateTokens(brief);
    const roomLeft = budget.inputTokens - spent.inputTokens;
    if (wanted > roomLeft) {
      // Refused before any charge exists: a hire that cannot fit its budget must never be sold, since
      // there is no refund to put it right afterwards.
      throw fail(
        `That brief needs about ${wanted} input tokens and this hire's budget has ${roomLeft}. Split the job or hire an agent with a larger budget.`,
        'invalid_request',
      );
    }

    this.#assertRoom({ callerAddress, parent });

    const id = this.newId();
    const hire = {
      id,
      contextId: contextId ?? this.newId(),
      slug, tier: resolved.tier, model: chosen, skill: skill ?? listing.skills[0]?.id ?? null,
      state: STATE.submitted,
      statusText: null,
      token: this.newToken(),
      createdAt: this.now(), updatedAt: this.now(),
      history: [{ role: 'ROLE_USER', text: brief, data, at: this.now() }],
      artifacts: [],
      budget, spent,
      turns: 0,
      charge: null,
      free: false,
      retryable: false,
      callerAddress,
      parentId: parent?.id ?? null,
      subHires: [],
      payment: null,
      expiresAt: null,
    };
    this.#hires.set(id, hire);

    // A sub-hire is covered by the charge its parent already paid. It never asks for money of its own.
    if (parent) {
      hire.free = true;
      hire.freeReason = 'covered by the parent hire';
      parent.subHires.push(id);
      await this.#work(hire);
      this.#persist();
      return { hire, hireToken: hire.token };
    }

    const sku = skuFor(listing, resolved.tier);
    hire.sku = sku;
    try {
      const priced = this.billing.isPriced ? await this.billing.isPriced(sku) : true;
      if (!priced) {
        hire.free = true;
        hire.freeReason = `${sku} has no price on this deployment`;
      } else {
        const result = await this.billing.openCharge({
          sku, units: 1, subject: `hire:${id}`,
          description: `${listing.name} (${resolved.tier}) for one hire`,
          idempotencyKey: `hire:${id}`,
          expiresInSeconds: this.config.payWindowSeconds,
        });
        if (result.free) {
          hire.free = true;
          hire.freeReason = `${sku} has no price on this deployment`;
        } else {
          hire.charge = {
            id: result.charge.id, sku, amountMicro: result.charge.amountMicro ?? null,
            status: result.charge.status, payUrl: result.payUrl ?? null, paymentUrl: result.paymentUrl ?? null,
            payer: result.charge.payer ?? null,
          };
          hire.expiresAt = this.now() + this.config.payWindowSeconds * 1000;
        }
      }
      this.billingUnavailableSince = null;
    } catch (error) {
      if (error instanceof PaymentUnavailable) {
        // Nothing is lost by not starting work, so a new hire is refused outright while the payment
        // service is unreachable. Work already paid for is treated differently, in tick().
        this.#hires.delete(id);
        this.billingUnavailableSince ??= this.now();
        throw fail('Payments are unavailable, so no new hire can be taken right now. Nothing was charged.', 'payment_unavailable');
      }
      this.#hires.delete(id);
      throw error;
    }

    if (hire.charge && hire.charge.status !== 'paid') {
      hire.state = STATE.inputRequired;
      hire.statusText = `This hire costs ${this.#amountText(hire)}. Pay the charge and the work starts. Nothing runs before it is paid.`;
      hire.payment = { status: 'payment-required', required: await this.#challenge(hire), receipts: [] };
      this.#persist();
      return { hire, hireToken: hire.token };
    }

    if (defer) this.#defer(hire);
    else if (returnImmediately) {
      hire.state = STATE.working;
      this.#run(hire);
    } else {
      await this.#work(hire);
    }
    this.#persist();
    return { hire, hireToken: hire.token };
  }

  // A streamed hire has its work held until the caller is subscribed, so the events it paid to watch
  // (working, then artifacts, then the final status) cannot happen before it is listening.
  #defer(hire) {
    hire.startWork = () => {
      delete hire.startWork;
      this.#run(hire);
    };
  }

  // A message on an existing hire: a payment submission, a follow-up turn, or a retry after our own
  // failure. Which one it is depends on the state, not on the caller telling us.
  async send({ id, text = '', data = null, message = null, payment = null, tokenPresented = null, returnImmediately = false, defer = false }) {
    const hire = this.get(id);

    if (payment?.status === 'payment-rejected') {
      hire.payment = { ...(hire.payment ?? {}), status: 'payment-rejected', receipts: hire.payment?.receipts ?? [] };
      hire.state = STATE.rejected;
      hire.statusText = 'The buyer rejected the payment requirements, so this hire was never taken.';
      hire.updatedAt = this.now();
      this.#persist();
      this.#notify(hire);
      return hire;
    }

    if (payment?.payload) {
      await this.#settle(hire, payment.payload);
      if (hire.state === STATE.working || hire.state === STATE.submitted) {
        if (defer) this.#defer(hire);
        else if (returnImmediately) this.#run(hire);
        else await this.#work(hire);
      }
      this.#persist();
      return hire;
    }

    // Everything past here continues someone's hire, so it needs the hire token.
    this.authorize(id, tokenPresented);

    if (hire.state === STATE.inputRequired && hire.charge && hire.charge.status !== 'paid') {
      await this.refresh(hire.id);
      if (hire.charge.status !== 'paid') {
        throw fail(`This hire is waiting for payment of ${this.#amountText(hire)}. Pay ${hire.charge.payUrl} or submit an x402 payload.`, 'payment_required');
      }
    }
    if (hire.state === STATE.canceled || hire.state === STATE.rejected) {
      throw fail(`This hire is ${hire.state === STATE.canceled ? 'cancelled' : 'rejected'} and cannot be continued`, 'unsupported_operation');
    }
    if (hire.state === STATE.working) {
      throw fail('This hire is already working. Wait for it, or subscribe to the task.', 'unsupported_operation');
    }

    const brief = this.#briefFrom({ text, data, message });
    if (brief.trim()) hire.history.push({ role: 'ROLE_USER', text: brief, data, at: this.now() });
    else if (!hire.retryable) throw fail('A follow-up needs at least one text or data part', 'invalid_request');

    if (defer) this.#defer(hire);
    else if (returnImmediately) {
      hire.state = STATE.working;
      this.#run(hire);
    } else {
      await this.#work(hire);
    }
    this.#persist();
    return hire;
  }

  async cancel(id, tokenPresented) {
    const hire = this.authorize(id, tokenPresented);
    if (isTerminal(hire.state)) throw fail(`This hire is already ${hire.state}`, 'not_cancelable');
    hire.state = STATE.canceled;
    hire.statusText = 'Cancelled by the buyer.';
    hire.updatedAt = this.now();
    this.#persist();
    this.#notify(hire);
    return hire;
  }

  // ------------------------------------------------------------------ payment

  async refresh(id) {
    const hire = this.get(id);
    if (!hire.charge || hire.charge.status === 'paid') return hire;
    try {
      const { charge } = await this.billing.getCharge(hire.charge.id);
      hire.charge.status = charge.status;
      hire.charge.payer = charge.payer ?? hire.charge.payer;
      this.billingUnavailableSince = null;
      if (charge.status === 'paid' && hire.state === STATE.inputRequired) {
        hire.payment = { ...(hire.payment ?? { receipts: [] }), status: 'payment-completed' };
        hire.state = STATE.submitted;
        hire.statusText = null;
      }
      if ((charge.status === 'expired' || charge.status === 'failed') && !isTerminal(hire.state)) {
        hire.state = STATE.rejected;
        hire.statusText = charge.status === 'expired'
          ? 'The charge for this hire expired before it was paid, so no work was done. Hire again to get a new charge.'
          : `The payment for this hire failed: ${charge.failureReason ?? 'unknown reason'}. Hire again to get a new charge.`;
      }
      hire.updatedAt = this.now();
      this.#persist();
    } catch (error) {
      if (error instanceof PaymentUnavailable) this.billingUnavailableSince ??= this.now();
      else throw error;
    }
    return hire;
  }

  // The buyer's signed x402 payload goes to the payment service, which verifies, settles and confirms
  // on its own RPC. We never hold a key and never decide that a payment is good.
  async #settle(hire, payload) {
    if (!hire.charge) throw fail('This hire is free on this deployment: there is nothing to pay', 'invalid_request');
    if (hire.charge.status === 'paid') return hire;
    const result = await this.billing.submitPayment(hire.charge.paymentUrl, payload);
    const receipts = hire.payment?.receipts ?? [];
    if (result.settled) receipts.push(result.settled);
    if (result.status === 200 && result.charge?.status === 'paid') {
      hire.charge.status = 'paid';
      hire.charge.payer = result.charge.payer ?? null;
      hire.payment = { ...(hire.payment ?? {}), status: 'payment-completed', receipts };
      hire.state = STATE.submitted;
      hire.statusText = null;
    } else if (result.status === 202) {
      hire.payment = { ...(hire.payment ?? {}), status: 'payment-verified', receipts };
      hire.statusText = 'Payment received and being confirmed on chain. Do not pay again.';
    } else {
      hire.payment = {
        ...(hire.payment ?? {}),
        status: 'payment-failed',
        error: result.settled?.errorReason ?? result.error?.code ?? 'SETTLEMENT_FAILED',
        receipts,
      };
      // Left in input-required on purpose: the buyer can sign again against the same requirements.
      hire.state = STATE.inputRequired;
      hire.statusText = `That payment did not go through: ${result.error?.message ?? result.settled?.errorReason ?? 'unknown reason'}. The requirements are unchanged.`;
    }
    hire.updatedAt = this.now();
    this.#notify(hire);
    return hire;
  }

  async #challenge(hire) {
    try {
      return await this.billing.challenge(hire.charge.paymentUrl);
    } catch {
      // A quote with no requirements is still useful: the payment sheet url works for a person.
      return null;
    }
  }

  #amountText(hire) {
    const micro = hire.charge?.amountMicro;
    if (micro === null || micro === undefined) return 'the amount on the payment sheet';
    return `${(micro / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
  }

  // ---------------------------------------------------------------- the work

  #run(hire) {
    hire.working = this.#work(hire).catch(() => {});
  }

  async #work(hire) {
    const listing = this.catalog.get(hire.slug);
    hire.state = STATE.working;
    hire.statusText = null;
    hire.retryable = false;
    hire.updatedAt = this.now();
    this.#notify(hire);
    try {
      if (listing.orchestrator) await this.#workAsForeman(hire, listing);
      else await this.#workAsSpecialist(hire, listing);
      hire.state = STATE.completed;
      hire.updatedAt = this.now();
      this.#notify(hire);
    } catch (error) {
      hire.state = STATE.failed;
      hire.updatedAt = this.now();
      // Our failure is free: the charge stays with the task, and resending on it re-runs the work.
      const ours = error.code === 'provider_failed' || error.code === 'provider_unpaid' || error.code === 'model_unavailable';
      hire.retryable = ours && Boolean(hire.charge || hire.free);
      hire.statusText = ours
        ? `${error.message}. This is our failure, not yours: send the message again on this task and it re-runs at no extra cost.`
        : error.message;
      hire.error = { code: error.code ?? 'failed', message: error.message };
      this.#notify(hire);
      if (!ours) throw error;
    } finally {
      this.#persist();
    }
    return hire;
  }

  async #ask(hire, { system, messages, wantOutput }) {
    const outputRoom = hire.budget.outputTokens - hire.spent.outputTokens;
    if (outputRoom <= 0) throw fail('This hire has spent its output budget', 'budget_spent');
    if (hire.turns >= this.config.maxTurns) throw fail(`This hire has used its ${this.config.maxTurns} turns`, 'budget_spent');
    const answer = await this.models.run({
      key: hire.model, system, messages,
      // One turn can never spend more than the hire has left, so the ceiling sent upstream is the
      // remaining budget rather than what the listing would like.
      maxOutputTokens: Math.max(1, Math.min(wantOutput ?? outputRoom, outputRoom)),
    });
    hire.turns += 1;
    hire.spent.inputTokens += Math.max(0, answer.usage?.inputTokens ?? 0);
    hire.spent.outputTokens += Math.max(0, answer.usage?.outputTokens ?? 0);
    hire.spent.counted = answer.usage?.counted === 'provider' && hire.spent.counted !== 'estimated' ? 'provider' : (answer.usage?.counted ?? 'estimated');
    hire.updatedAt = this.now();
    if (!answer.text?.trim()) throw fail('The model returned nothing', 'provider_failed');
    return answer;
  }

  async #workAsSpecialist(hire, listing) {
    const messages = hire.history.map((turn) => ({
      role: turn.role === 'ROLE_AGENT' ? 'assistant' : 'user',
      content: turn.data ? `${turn.text}\n\n${JSON.stringify(turn.data)}`.trim() : turn.text,
    }));
    const answer = await this.#ask(hire, { system: listing.instructions, messages });
    hire.history.push({ role: 'ROLE_AGENT', text: answer.text, at: this.now() });

    if (listing.output.kind === 'data') {
      const parsed = parseJson(answer.text);
      if (parsed.ok) {
        this.#addArtifact(hire, { name: listing.output.name, data: parsed.value, mediaType: 'application/json' });
        return;
      }
      // One repair attempt, inside the same budget, because a listing that promises JSON has to deliver
      // JSON or say it could not.
      const repair = await this.#ask(hire, {
        system: listing.instructions,
        messages: [...messages, { role: 'assistant', content: answer.text }, { role: 'user', content: `That was not valid JSON (${parsed.error}). Answer again with the JSON value only, nothing else.` }],
      });
      const second = parseJson(repair.text);
      hire.history.push({ role: 'ROLE_AGENT', text: repair.text, at: this.now() });
      if (!second.ok) throw fail(`This hire promised JSON and the model would not produce it (${second.error})`, 'provider_failed');
      this.#addArtifact(hire, { name: listing.output.name, data: second.value, mediaType: 'application/json' });
      return;
    }
    this.#addArtifact(hire, { name: listing.output.name, text: answer.text, mediaType: 'text/plain' });
  }

  // The foreman plans, hires from the hall, then answers with its own synthesis. Its sub-hires are
  // free and spend the parent's budget, so the buyer pays once for the whole job.
  async #workAsForeman(hire, listing) {
    const hireable = listing.hires.filter((slug) => this.catalog.has(slug) && !this.catalog.get(slug).orchestrator);
    const roster = hireable.map((slug) => {
      const l = this.catalog.get(slug);
      return `- ${slug}: ${l.name}. ${l.description}`;
    }).join('\n');
    const job = hire.history.filter((t) => t.role === 'ROLE_USER').map((t) => t.text).join('\n\n');

    const plan = await this.#ask(hire, {
      system: listing.instructions,
      messages: [{ role: 'user', content: `Agents you may hire:\n${roster}\n\nThe job:\n${job}\n\nAnswer with the plan JSON only.` }],
      wantOutput: Math.min(1_000, hire.budget.outputTokens),
    });
    const parsedPlan = parseJson(plan.text);
    const wanted = parsedPlan.ok && Array.isArray(parsedPlan.value?.hires) ? parsedPlan.value.hires.slice(0, 3) : [];

    const results = [];
    for (const step of wanted) {
      const slug = typeof step?.agent === 'string' ? step.agent : null;
      const brief = typeof step?.brief === 'string' ? step.brief : '';
      if (!slug || !hireable.includes(slug) || !brief.trim()) {
        results.push({ slug: slug ?? '(none)', ok: false, detail: 'the foreman asked for an agent this hall does not have, or sent no brief' });
        continue;
      }
      // Pick a model the sub-listing will actually take, preferring the one this hire is running on.
      const sub = this.catalog.get(slug);
      const model = sub.tiers.includes(hire.tier) && this.#modelIsUsable(hire.model) ? hire.model : sub.defaultModel;
      try {
        const { hire: child } = await this.hire({ slug, text: brief, model, contextId: hire.contextId, parent: hire, callerAddress: hire.callerAddress });
        const delivered = child.artifacts.at(-1);
        const detail = delivered?.data !== undefined && delivered?.data !== null ? JSON.stringify(delivered.data) : (delivered?.text ?? '');
        results.push({ slug, ok: child.state === STATE.completed, taskId: child.id, detail: detail || (child.statusText ?? 'nothing came back') });
        for (const artifact of child.artifacts) {
          this.#addArtifact(hire, { ...artifact, name: `${slug}/${artifact.name}`, from: { slug, taskId: child.id } });
        }
      } catch (error) {
        results.push({ slug, ok: false, detail: `could not be hired: ${error.message}` });
      }
    }

    const report = results.length
      ? results.map((r) => `${r.slug} (${r.ok ? 'delivered' : 'failed'}): ${String(r.detail).slice(0, 4_000)}`).join('\n\n')
      : 'You hired nobody.';
    const synthesis = await this.#ask(hire, {
      system: listing.instructions,
      messages: [
        { role: 'user', content: `The job:\n${job}` },
        { role: 'assistant', content: plan.text },
        { role: 'user', content: `What came back:\n\n${report}\n\nNow answer with the synthesis.` },
      ],
    });
    hire.history.push({ role: 'ROLE_AGENT', text: synthesis.text, at: this.now() });
    this.#addArtifact(hire, { name: listing.output.name, text: synthesis.text, mediaType: 'text/plain' });
    hire.plan = { hires: results.map(({ slug, ok, taskId }) => ({ slug, ok, taskId: taskId ?? null })) };
  }

  #modelIsUsable(key) {
    try { this.models.resolve(key); return true; } catch { return false; }
  }

  #addArtifact(hire, { name, text = null, data = null, mediaType = 'text/plain', from = null }) {
    const artifact = { artifactId: this.newId(), name, text, data, mediaType, at: this.now(), from };
    hire.artifacts.push(artifact);
    hire.updatedAt = this.now();
    this.#notify(hire, { artifact });
    return artifact;
  }

  // -------------------------------------------------------------------- caps

  #assertRoom({ callerAddress, parent }) {
    if (parent) return; // a sub-hire runs inside work that is already counted
    const working = [...this.#hires.values()].filter((h) => h.state === STATE.working && !h.parentId).length;
    if (working >= this.config.maxConcurrentHires) {
      throw fail('The hall is at capacity right now. Try again shortly; nothing was charged.', 'at_capacity');
    }
    if (callerAddress) {
      const mineWorking = [...this.#hires.values()].filter((h) => h.callerAddress === callerAddress && h.state === STATE.working).length;
      if (mineWorking >= this.config.maxConcurrentPerOrg) {
        throw fail(`That caller already has ${mineWorking} hires working. Wait for one to finish.`, 'at_capacity');
      }
      // Hires awaiting payment are capped separately and never count against the working cap: an
      // unpaid queue must not be able to lock out paying buyers.
      const mineWaiting = [...this.#hires.values()].filter((h) => h.callerAddress === callerAddress && h.state === STATE.inputRequired).length;
      if (mineWaiting >= this.config.maxAwaitingPaymentPerOrg) {
        throw fail(`That caller has ${mineWaiting} hires waiting to be paid for. Pay or abandon those first.`, 'at_capacity');
      }
    }
  }

  // One sweep decides who has run out of time to pay and who has been working too long. Called by the
  // server on a timer, and by tests directly after moving the clock.
  async tick() {
    const now = this.now();
    for (const hire of this.#hires.values()) {
      if (hire.state === STATE.inputRequired && hire.expiresAt && now >= hire.expiresAt) {
        await this.refresh(hire.id);
        if (hire.state === STATE.inputRequired) {
          hire.state = STATE.rejected;
          hire.statusText = 'Nobody paid for this hire inside the payment window, so it was never taken. Hire again to get a new charge.';
          hire.updatedAt = now;
          this.#notify(hire);
        }
      }
      if (hire.state === STATE.working && now - hire.updatedAt > this.config.taskSeconds * 1000) {
        hire.state = STATE.failed;
        hire.retryable = true;
        hire.statusText = `This hire went quiet for more than ${this.config.taskSeconds} seconds. That is our failure: send the message again on this task and it re-runs at no extra cost.`;
        hire.updatedAt = now;
        this.#notify(hire);
      }
      // Work already paid for is given the benefit of the doubt while payments are down, and then
      // stopped. A new hire is refused outright, in hire().
      if (this.billingUnavailableSince && hire.state === STATE.working && now - this.billingUnavailableSince > this.config.billingGraceSeconds * 1000) {
        hire.state = STATE.failed;
        hire.retryable = true;
        hire.statusText = 'Payments have been unreachable for too long, so this hire was stopped. It is paid for: send the message again once we are back and it re-runs at no extra cost.';
        hire.updatedAt = now;
        this.#notify(hire);
      }
    }
    this.#persist();
  }

  // ------------------------------------------------------------------ events

  // Subscribers get every change to one hire: status moves and artifacts, in order.
  subscribe(id) {
    const queue = [];
    let resolveNext = null;
    const listener = (event) => {
      queue.push(event);
      if (resolveNext) { const r = resolveNext; resolveNext = null; r(); }
    };
    const listeners = this.#waiters.get(id) ?? new Set();
    listeners.add(listener);
    this.#waiters.set(id, listeners);
    const hall = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            for (;;) {
              if (queue.length) return { value: queue.shift(), done: false };
              const hire = hall.#hires.get(id);
              if (hire && isTerminal(hire.state) && !queue.length) return { value: undefined, done: true };
              await new Promise((resolve) => { resolveNext = resolve; });
            }
          },
          async return() {
            listeners.delete(listener);
            if (!listeners.size) hall.#waiters.delete(id);
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  #notify(hire, extra = {}) {
    const listeners = this.#waiters.get(hire.id);
    if (!listeners?.size) return;
    for (const listener of listeners) listener({ hire, ...extra, at: this.now() });
  }

  // ----------------------------------------------------------------- console

  summary() {
    const hires = [...this.#hires.values()].sort((a, b) => b.createdAt - a.createdAt);
    const paid = hires.filter((h) => h.charge?.status === 'paid');
    return {
      hires: hires.map((h) => ({
        id: h.id, slug: h.slug, tier: h.tier, model: h.model, state: h.state,
        createdAt: h.createdAt, updatedAt: h.updatedAt, turns: h.turns,
        spent: h.spent, budget: h.budget,
        free: h.free, freeReason: h.freeReason ?? null,
        charge: h.charge ? { id: h.charge.id, sku: h.charge.sku, status: h.charge.status, amountMicro: h.charge.amountMicro } : null,
        artifacts: h.artifacts.length, parentId: h.parentId, subHires: h.subHires,
        statusText: h.statusText,
      })),
      counts: {
        hires: hires.length,
        working: hires.filter((h) => h.state === STATE.working).length,
        awaitingPayment: hires.filter((h) => h.state === STATE.inputRequired).length,
        completed: hires.filter((h) => h.state === STATE.completed).length,
        failed: hires.filter((h) => h.state === STATE.failed).length,
        // A free hire was never bought, and the console must not imply otherwise.
        freeHires: hires.filter((h) => h.free).length,
        paidHires: paid.length,
        paidMicro: paid.reduce((n, h) => n + (h.charge.amountMicro ?? 0), 0),
        // Token counts are what the providers reported, or estimated where one reported nothing.
        inputTokens: hires.reduce((n, h) => n + h.spent.inputTokens, 0),
        outputTokens: hires.reduce((n, h) => n + h.spent.outputTokens, 0),
        estimatedCounts: hires.filter((h) => h.spent.counted === 'estimated').length,
      },
      billingUnavailableSince: this.billingUnavailableSince,
    };
  }

  // --------------------------------------------------------------- internals

  #briefFrom({ text, data, message }) {
    if (message) {
      const parts = message.parts ?? [];
      const texts = parts.filter((p) => typeof p.text === 'string').map((p) => p.text);
      const datas = parts.filter((p) => p.data !== undefined && p.data !== null).map((p) => JSON.stringify(p.data));
      return [...texts, ...datas].join('\n\n').trim();
    }
    return [text ?? '', data ? JSON.stringify(data) : ''].filter(Boolean).join('\n\n').trim();
  }

  #persist() {
    if (!this.store?.saveHires) return;
    this.store.saveHires([...this.#hires.values()].map(({ working, startWork, ...rest }) => rest));
  }
}

function parseJson(text) {
  const trimmed = (text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try { return { ok: true, value: JSON.parse(trimmed) }; } catch (error) { return { ok: false, error: error.message }; }
}
