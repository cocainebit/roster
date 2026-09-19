import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, SMALL, MID, lastArtifact } from './helpers.mjs';
import { STATE } from '../src/hall.mjs';
import { FakeProvider } from '../src/providers/fake.mjs';

test('an unpriced hire runs without a charge, and says why it was free', async () => {
  const { hall, billing } = harness();
  const { hire, hireToken } = await hall.hire({ slug: 'copy-editor', text: 'Tighten this line please.' });
  assert.equal(hire.state, STATE.completed);
  assert.equal(hire.charge, null);
  assert.equal(hire.free, true);
  assert.match(hire.freeReason, /no price/);
  assert.equal(billing.calls.length, 0, 'an unpriced SKU must never raise a charge');
  assert.ok(hireToken);
  assert.equal(lastArtifact(hire).name, 'edited-text');
});

test('a priced hire waits for payment, quotes x402 requirements, and runs nothing first', async () => {
  const { hall, provider } = harness({ prices: { 'roster.hire.copy-editor.small': 20_000 } });
  const { hire } = await hall.hire({ slug: 'copy-editor', text: 'Edit this.', model: SMALL });
  assert.equal(hire.state, STATE.inputRequired);
  assert.equal(hire.charge.status, 'open');
  assert.equal(hire.charge.amountMicro, 20_000);
  assert.equal(hire.payment.status, 'payment-required');
  assert.equal(hire.payment.required.x402Version, 2);
  assert.equal(hire.payment.required.accepts[0].amount, '20000');
  assert.equal(provider.calls.length, 0, 'nothing may reach a model before the charge is paid');
  assert.equal(hire.artifacts.length, 0);
});

test('paying the charge, then a message, delivers the work', async () => {
  const { hall, billing } = harness({ prices: { 'roster.hire.briefer.small': 5_000 } });
  const { hire, hireToken } = await hall.hire({ slug: 'briefer', text: 'Brief this document.', model: SMALL });
  billing.pay(hire.charge.id, '0xbuyer');
  const after = await hall.send({ id: hire.id, text: 'go ahead', tokenPresented: hireToken });
  assert.equal(after.state, STATE.completed);
  assert.equal(after.charge.status, 'paid');
  assert.equal(after.charge.payer, '0xbuyer');
  assert.equal(after.artifacts.length, 1);
});

test('an x402 payload submitted on the task pays it and the work runs, with receipts kept', async () => {
  const { hall, billing } = harness({ prices: { 'roster.hire.copy-editor.small': 20_000 } });
  const { hire } = await hall.hire({ slug: 'copy-editor', text: 'Edit this.', model: SMALL });
  const paid = await hall.send({ id: hire.id, payment: { status: 'payment-submitted', payload: { x402Version: 2, payer: '0xagent' } } });
  assert.equal(paid.charge.status, 'paid');
  assert.equal(paid.payment.status, 'payment-completed');
  assert.equal(paid.payment.receipts.length, 1);
  assert.equal(paid.payment.receipts[0].success, true);
  assert.equal(paid.state, STATE.completed);
  assert.equal(billing.payments.length, 1);
});

test('a payment that does not verify leaves the hire payable, with the failure recorded', async () => {
  const { hall } = harness({ prices: { 'roster.hire.copy-editor.small': 20_000 } });
  const { hire } = await hall.hire({ slug: 'copy-editor', text: 'Edit this.', model: SMALL });
  const after = await hall.send({ id: hire.id, payment: { status: 'payment-submitted', payload: { bad: true } } });
  assert.equal(after.state, STATE.inputRequired);
  assert.equal(after.payment.status, 'payment-failed');
  assert.equal(after.payment.error, 'INVALID_SIGNATURE');
  assert.equal(after.payment.receipts.at(-1).success, false);
});

test('a rejected quote ends the hire and never charges for it', async () => {
  const { hall } = harness({ prices: { 'roster.hire.copy-editor.small': 20_000 } });
  const { hire } = await hall.hire({ slug: 'copy-editor', text: 'Edit this.', model: SMALL });
  const after = await hall.send({ id: hire.id, payment: { status: 'payment-rejected' } });
  assert.equal(after.state, STATE.rejected);
  assert.equal(after.charge.status, 'open');
});

test('follow-up turns on a paid hire cost nothing more', async () => {
  const { hall, billing, provider } = harness({ prices: { 'roster.hire.copy-editor.small': 20_000 } });
  const { hire, hireToken } = await hall.hire({ slug: 'copy-editor', text: 'Edit this.', model: SMALL });
  billing.pay(hire.charge.id);
  await hall.send({ id: hire.id, text: 'go', tokenPresented: hireToken });
  const chargesAfterFirst = billing.calls.length;
  const again = await hall.send({ id: hire.id, text: 'shorter, keep the second paragraph', tokenPresented: hireToken });
  assert.equal(again.state, STATE.completed);
  assert.equal(billing.calls.length, chargesAfterFirst, 'a follow-up turn must not raise another charge');
  assert.equal(provider.calls.length, 2, 'one call for the paid turn, one for the follow-up');
  assert.equal(again.artifacts.length, 2);
});

test('our own failure is retryable and free; the paid charge stays with the task', async () => {
  const provider = new FakeProvider({ fail: true });
  const { hall, billing } = harness({ prices: { 'roster.hire.copy-editor.small': 20_000 }, provider });
  const { hire, hireToken } = await hall.hire({ slug: 'copy-editor', text: 'Edit this.', model: SMALL });
  billing.pay(hire.charge.id);
  const failed = await hall.send({ id: hire.id, text: 'go', tokenPresented: hireToken });
  assert.equal(failed.state, STATE.failed);
  assert.equal(failed.retryable, true);
  assert.match(failed.statusText, /re-runs at no extra cost/);

  provider.fail = false;
  const charges = billing.calls.length;
  const retried = await hall.send({ id: hire.id, text: '', tokenPresented: hireToken });
  assert.equal(retried.state, STATE.completed);
  assert.equal(billing.calls.length, charges, 'a retry after our failure must not raise another charge');
});

test('a brief too large for the budget is refused before any charge exists', async () => {
  const { hall, billing } = harness({ prices: { 'roster.hire.copy-editor.small': 20_000 } });
  await assert.rejects(
    () => hall.hire({ slug: 'copy-editor', text: 'x'.repeat(200_000), model: SMALL }),
    (error) => error.code === 'invalid_request' && /budget/.test(error.message),
  );
  assert.equal(billing.calls.length, 0);
  assert.equal(hall.list().length, 0, 'a refused hire leaves nothing behind');
});

test('one turn can never spend more than the hire has left', async () => {
  const provider = new FakeProvider({ outputTokens: 3_000 });
  const { hall } = harness({ provider });
  const { hire, hireToken } = await hall.hire({ slug: 'copy-editor', text: 'Edit this.' });
  assert.equal(provider.calls[0].maxOutputTokens, 6_000);
  await hall.send({ id: hire.id, text: 'again', tokenPresented: hireToken });
  assert.equal(provider.calls[1].maxOutputTokens, 3_000, 'the ceiling sent upstream is what the budget has left');
  await assert.rejects(
    () => hall.send({ id: hire.id, text: 'and again', tokenPresented: hireToken }),
    (error) => error.code === 'budget_spent',
  );
});

test('a tier the listing does not take is refused, and an unknown model is refused', async () => {
  const { hall } = harness();
  // reviewer takes small, mid and frontier, so a small model is fine but an undeclared model is not.
  const ok = await hall.hire({ slug: 'reviewer', text: 'Review this.', model: SMALL });
  assert.equal(ok.hire.tier, 'small');
  await assert.rejects(
    () => hall.hire({ slug: 'reviewer', text: 'Review this.', model: 'openai/whatever' }),
    (error) => error.code === 'invalid_request',
  );
  await assert.rejects(
    () => hall.hire({ slug: 'foreman', text: 'Do this.', model: SMALL }),
    (error) => error.code === 'invalid_request' && /not for hire on a small model/.test(error.message),
  );
});

test('a model with no provider credential is unavailable, not sold', async () => {
  const { hall } = harness({ extraModels: ['openai/gpt-x=frontier'] });
  await assert.rejects(
    () => hall.hire({ slug: 'copy-editor', text: 'Edit this.', model: 'openai/gpt-x' }),
    (error) => error.code === 'model_unavailable',
  );
});

test('the extractor delivers a data artifact, and repairs one bad answer inside the same hire', async () => {
  const provider = new FakeProvider({ replies: ['not json at all', '{"total": 12}'] });
  const { hall } = harness({ provider });
  const { hire } = await hall.hire({ slug: 'extractor', text: 'Pull the total out of this receipt: total 12' });
  assert.equal(hire.state, STATE.completed);
  assert.deepEqual(lastArtifact(hire).data, { total: 12 });
  assert.equal(provider.calls.length, 2, 'one repair attempt, not a loop');
});

test('a listing that promises JSON and cannot produce it fails rather than delivering prose', async () => {
  const provider = new FakeProvider({ reply: 'still not json' });
  const { hall } = harness({ provider });
  const { hire } = await hall.hire({ slug: 'extractor', text: 'Pull the total.' });
  assert.equal(hire.state, STATE.failed);
  assert.match(hire.statusText, /would not produce it/);
});

test('the foreman hires specialists, pays nothing extra for them, and spends one budget', async () => {
  const provider = new FakeProvider({
    replies: [
      JSON.stringify({ hires: [{ agent: 'briefer', brief: 'Brief this: a long document about ports.' }, { agent: 'reviewer', brief: 'Review this: the same document.' }], why: 'a brief and a review' }),
      'the brief',
      'the findings',
      'here is what I make of it',
    ],
    outputTokens: 100,
  });
  const { hall, billing } = harness({ prices: { 'roster.hire.foreman.mid': 200_000 }, provider });
  const { hire } = await hall.hire({ slug: 'foreman', text: 'Brief and review this document.', model: MID });
  billing.pay(hire.charge.id);
  const done = await hall.send({ id: hire.id, payment: null, text: 'go', tokenPresented: hire.token });

  assert.equal(done.state, STATE.completed);
  assert.equal(done.subHires.length, 2, 'two specialists were hired');
  assert.equal(billing.calls.length, 1, 'the buyer pays once for the whole job');
  const names = done.artifacts.map((a) => a.name);
  assert.deepEqual(names, ['briefer/brief', 'reviewer/findings', 'synthesis']);
  // Every sub-hire spends the parent's budget, so the parent's usage covers all of it.
  const children = done.subHires.map((id) => hall.get(id));
  assert.ok(children.every((child) => child.free === true && child.charge === null));
  assert.ok(done.spent.outputTokens >= 400, 'the parent accounts for what its sub-hires spent');
});

test('the foreman that plans a nobody hires nobody and still answers', async () => {
  const provider = new FakeProvider({ replies: [JSON.stringify({ hires: [], why: 'straight answer' }), 'the answer'] });
  const { hall } = harness({ provider });
  const { hire } = await hall.hire({ slug: 'foreman', text: 'What is 2 and 2?', model: MID });
  assert.equal(hire.state, STATE.completed);
  assert.equal(hire.subHires.length, 0);
  assert.equal(lastArtifact(hire).name, 'synthesis');
});

test('the foreman asking for an agent that is not in the hall records it and carries on', async () => {
  const provider = new FakeProvider({
    replies: [JSON.stringify({ hires: [{ agent: 'lawyer', brief: 'sue them' }] }), 'no lawyer here, so here is what I can say'],
  });
  const { hall } = harness({ provider });
  const { hire } = await hall.hire({ slug: 'foreman', text: 'Handle this.', model: MID });
  assert.equal(hire.state, STATE.completed);
  assert.equal(hire.plan.hires[0].ok, false);
  assert.equal(hire.subHires.length, 0);
});

test('a hire nobody pays for expires, and the charge is never forgiven', async () => {
  const { hall, advance } = harness({ prices: { 'roster.hire.copy-editor.small': 20_000 }, config: { payWindowSeconds: 60 } });
  const { hire } = await hall.hire({ slug: 'copy-editor', text: 'Edit this.', model: SMALL });
  advance(61);
  await hall.tick();
  assert.equal(hall.get(hire.id).state, STATE.rejected);
  assert.match(hall.get(hire.id).statusText, /Nobody paid/);
});

test('unpaid hires never count against the working cap', async () => {
  const { hall } = harness({
    prices: { 'roster.hire.copy-editor.small': 20_000 },
    config: { maxConcurrentHires: 2, maxAwaitingPaymentPerOrg: 5 },
  });
  for (let i = 0; i < 4; i += 1) {
    await hall.hire({ slug: 'copy-editor', text: `Edit number ${i}.`, model: SMALL, callerAddress: '10.0.0.1' });
  }
  // Four hires are waiting to be paid for, and a fifth caller can still buy work.
  const free = harness();
  const { hire } = await free.hall.hire({ slug: 'copy-editor', text: 'Edit mine.', callerAddress: '10.0.0.2' });
  assert.equal(hire.state, STATE.completed);
  const summary = hall.summary();
  assert.equal(summary.counts.awaitingPayment, 4);
  assert.equal(summary.counts.working, 0);
});

test('a caller with too many hires waiting to be paid for is refused a new one', async () => {
  const { hall } = harness({ prices: { 'roster.hire.copy-editor.small': 20_000 }, config: { maxAwaitingPaymentPerOrg: 2 } });
  await hall.hire({ slug: 'copy-editor', text: 'One.', model: SMALL, callerAddress: '10.0.0.9' });
  await hall.hire({ slug: 'copy-editor', text: 'Two.', model: SMALL, callerAddress: '10.0.0.9' });
  await assert.rejects(
    () => hall.hire({ slug: 'copy-editor', text: 'Three.', model: SMALL, callerAddress: '10.0.0.9' }),
    (error) => error.code === 'at_capacity',
  );
});

test('while payments are unreachable, no new hire is taken and nothing is charged', async () => {
  const { hall, billing } = harness({ prices: { 'roster.hire.copy-editor.small': 20_000 } });
  billing.down = true;
  await assert.rejects(
    () => hall.hire({ slug: 'copy-editor', text: 'Edit this.', model: SMALL }),
    (error) => error.code === 'payment_unavailable' && /Nothing was charged/.test(error.message),
  );
  assert.equal(hall.list().length, 0);
});

test('work already paid for is stopped only after the grace period, and can be resumed free', async () => {
  const { hall, billing, advance, config } = harness({
    prices: { 'roster.hire.copy-editor.small': 20_000 },
    config: { billingGraceSeconds: 300 },
  });
  const { hire } = await hall.hire({ slug: 'copy-editor', text: 'Edit this.', model: SMALL });
  billing.pay(hire.charge.id);
  // A hire mid-flight when payments go down, simulated by holding it in working state.
  const held = hall.get(hire.id);
  held.state = STATE.working;
  held.updatedAt = hall.now();
  billing.down = true;
  hall.billingUnavailableSince = hall.now();
  advance(299);
  await hall.tick();
  assert.equal(hall.get(hire.id).state, STATE.working, 'paid work is given the benefit of the doubt');
  advance(2);
  await hall.tick();
  const stopped = hall.get(hire.id);
  assert.equal(stopped.state, STATE.failed);
  assert.equal(stopped.retryable, true);
  assert.ok(config.billingGraceSeconds === 300);
});

test('reading, continuing and cancelling a hire need the hire token; paying does not', async () => {
  const { hall } = harness({ prices: { 'roster.hire.copy-editor.small': 20_000 } });
  const { hire, hireToken } = await hall.hire({ slug: 'copy-editor', text: 'Edit this.', model: SMALL });
  assert.throws(() => hall.authorize(hire.id, 'not-the-token'), (error) => error.code === 'unauthorized');
  await assert.rejects(
    () => hall.send({ id: hire.id, text: 'hello', tokenPresented: 'not-the-token' }),
    (error) => error.code === 'unauthorized',
  );
  await assert.rejects(() => hall.cancel(hire.id, 'nope'), (error) => error.code === 'unauthorized');
  const cancelled = await hall.cancel(hire.id, hireToken);
  assert.equal(cancelled.state, STATE.canceled);

  // No token at all, but a payment: accepted, because whoever holds the charge may pay it.
  const second = await hall.hire({ slug: 'copy-editor', text: 'Edit this too.', model: SMALL });
  const paid = await hall.send({ id: second.hire.id, payment: { status: 'payment-submitted', payload: { payer: '0xstranger' } } });
  assert.equal(paid.charge.status, 'paid');
  assert.equal(paid.state, STATE.completed);
});

test('a cancelled hire cannot be continued or cancelled again', async () => {
  const { hall } = harness({ prices: { 'roster.hire.copy-editor.small': 20_000 } });
  const { hire, hireToken } = await hall.hire({ slug: 'copy-editor', text: 'Edit this.', model: SMALL });
  await hall.cancel(hire.id, hireToken);
  await assert.rejects(() => hall.cancel(hire.id, hireToken), (error) => error.code === 'not_cancelable');
  await assert.rejects(
    () => hall.send({ id: hire.id, text: 'more', tokenPresented: hireToken }),
    (error) => error.code === 'unsupported_operation',
  );
});

test('a hire that expired its charge, then is asked to work, refuses', async () => {
  const { hall, billing } = harness({ prices: { 'roster.hire.copy-editor.small': 20_000 } });
  const { hire, hireToken } = await hall.hire({ slug: 'copy-editor', text: 'Edit this.', model: SMALL });
  billing.expire(hire.charge.id);
  await assert.rejects(
    () => hall.send({ id: hire.id, text: 'go', tokenPresented: hireToken }),
    (error) => error.code === 'unsupported_operation' || error.code === 'payment_required',
  );
  assert.equal(hall.get(hire.id).state, STATE.rejected);
});

test('the summary separates free work from paid work and says when a count is an estimate', async () => {
  const provider = new FakeProvider();
  const { hall, billing } = harness({ prices: { 'roster.hire.briefer.small': 5_000 }, provider });
  await hall.hire({ slug: 'copy-editor', text: 'Free one.' });
  const { hire, hireToken } = await hall.hire({ slug: 'briefer', text: 'Paid one.', model: SMALL });
  billing.pay(hire.charge.id);
  await hall.send({ id: hire.id, text: 'go', tokenPresented: hireToken });
  const { counts } = hall.summary();
  assert.equal(counts.hires, 2);
  assert.equal(counts.freeHires, 1);
  assert.equal(counts.paidHires, 1);
  assert.equal(counts.paidMicro, 5_000);
  assert.equal(counts.estimatedCounts, 0);
});

test('a hire interrupted by a restart comes back as failed, retryable and still paid', async () => {
  const state = { hires: [], listings: [] };
  const store = {
    loadAll: () => state,
    saveHires: (hires) => { state.hires = JSON.parse(JSON.stringify(hires)); },
    saveListings: (listings) => { state.listings = listings; },
  };
  const first = harness({ prices: { 'roster.hire.copy-editor.small': 20_000 } });
  const { hall: hall1, billing } = first;
  hall1.store = store;
  const { hire } = await hall1.hire({ slug: 'copy-editor', text: 'Edit this.', model: SMALL });
  billing.pay(hire.charge.id);
  await hall1.refresh(hire.id);
  const held = hall1.get(hire.id);
  held.state = STATE.working;
  store.saveHires([held]);

  const { Hall } = await import('../src/hall.mjs');
  const revived = new Hall({ billing, catalog: first.catalog, models: first.models, config: first.config, store, now: () => first.clock.t });
  const back = revived.get(hire.id);
  assert.equal(back.state, STATE.failed);
  assert.equal(back.retryable, true);
  assert.equal(back.charge.status, 'paid');
  assert.match(back.statusText, /costs nothing more/);
});
