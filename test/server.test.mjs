import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve, SMALL } from './helpers.mjs';
import { X402_EXTENSION_URI } from '../src/hall.mjs';

test('the hall answers healthz and serves a card at the well-known path', async () => {
  const app = await serve();
  try {
    const health = await app.get('/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.body.listings, 5);
    assert.deepEqual(health.body.protocols, ['a2a/1.0 (JSONRPC)', 'a2a/0.3 (JSONRPC)']);

    const card = await app.get('/.well-known/agent-card.json');
    assert.equal(card.status, 200);
    assert.equal(card.body.name, 'Roster');
    assert.ok(card.body.skills.length >= 5);

    const listing = await app.get('/agents/reviewer/.well-known/agent-card.json');
    assert.equal(listing.status, 200);
    assert.equal(listing.body.name, 'Reviewer');
    assert.equal(listing.body.supportedInterfaces[0].url, `${app.base}/agents/reviewer/a2a/v1`);

    const missing = await app.get('/agents/nobody/.well-known/agent-card.json');
    assert.equal(missing.status, 404);
  } finally { await app.close(); }
});

test('SendMessage hires over A2A 1.0 and hands back the hire token once', async () => {
  const app = await serve();
  try {
    const { status, body, headers } = await app.rpc('SendMessage', {
      message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Edit this line for me.' }] },
    }, { path: '/agents/copy-editor/a2a/v1', headers: { 'X-A2A-Extensions': `${X402_EXTENSION_URI}, https://example.com/other` } });
    assert.equal(status, 200);
    const task = body.result.task;
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(task.artifacts[0].name, 'edited-text');
    assert.ok(task.metadata['roster/hireToken']);
    // Only the extensions we actually implement are echoed back.
    assert.equal(headers.get('x-a2a-extensions'), X402_EXTENSION_URI);
  } finally { await app.close(); }
});

test('message/send hires over A2A 0.3 from the same endpoint, answered in 0.3', async () => {
  const app = await serve();
  try {
    const { body } = await app.rpc('message/send', {
      message: { messageId: 'm1', role: 'user', kind: 'message', parts: [{ kind: 'text', text: 'Brief this document.' }], metadata: { 'roster/agent': 'briefer' } },
    });
    const task = body.result;
    assert.equal(task.kind, 'task');
    assert.equal(task.status.state, 'completed');
    assert.equal(task.artifacts[0].parts[0].kind, 'text');
  } finally { await app.close(); }
});

test('hiring through the hall endpoint needs the agent named, and says how', async () => {
  const app = await serve();
  try {
    const { body } = await app.rpc('SendMessage', { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'do something' }] } });
    assert.equal(body.error.code, -32602);
    assert.match(body.error.message, /Name the agent/);

    const bySkill = await app.rpc('SendMessage', {
      message: { messageId: 'm2', role: 'ROLE_USER', parts: [{ text: 'Edit this.' }], metadata: { 'roster/skill': 'copy-editor:edit' } },
    });
    assert.equal(bySkill.body.result.task.metadata['roster/agent'], 'copy-editor');
  } finally { await app.close(); }
});

test('a priced hire is quoted over A2A and paid with an x402 payload on the same task', async () => {
  const app = await serve({ prices: { 'roster.hire.copy-editor.small': 20_000 } });
  try {
    const quote = await app.rpc('SendMessage', {
      message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Edit this.' }], metadata: { 'roster/model': SMALL } },
    }, { path: '/agents/copy-editor/a2a/v1' });
    const task = quote.body.result.task;
    assert.equal(task.status.state, 'TASK_STATE_INPUT_REQUIRED');
    const required = task.status.message.metadata['x402.payment.required'];
    assert.equal(required.accepts[0].amount, '20000');
    assert.equal(app.provider.calls.length, 0);

    // Paying needs no hire token: whoever holds the task id and a funded wallet can pay it.
    const paid = await app.rpc('SendMessage', {
      message: {
        messageId: 'm2', role: 'ROLE_USER', taskId: task.id, parts: [{ text: 'Here is the payment.' }],
        metadata: { 'x402.payment.status': 'payment-submitted', 'x402.payment.payload': { x402Version: 2, payer: '0xagent' } },
      },
    }, { path: '/agents/copy-editor/a2a/v1' });
    const done = paid.body.result.task;
    assert.equal(done.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(done.status.message.metadata['x402.payment.status'], 'payment-completed');
    assert.equal(done.artifacts.length, 1);
  } finally { await app.close(); }
});

test('GetTask, CancelTask and ListTasks need the hire token', async () => {
  const app = await serve();
  try {
    const hired = await app.rpc('SendMessage', {
      message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Edit this.' }] },
    }, { path: '/agents/copy-editor/a2a/v1' });
    const task = hired.body.result.task;
    const token = task.metadata['roster/hireToken'];

    const denied = await app.rpc('GetTask', { id: task.id });
    assert.equal(denied.status, 401);
    assert.equal(denied.body.error.code, -32600);

    const allowed = await app.rpc('GetTask', { id: task.id }, { token });
    assert.equal(allowed.body.result.id, task.id);
    // A task read later never re-issues the hire token.
    assert.equal(allowed.body.result.metadata['roster/hireToken'], undefined);

    const missing = await app.rpc('GetTask', { id: 'nope' }, { token });
    assert.equal(missing.body.error.code, -32001);

    const listed = await app.rpc('ListTasks', { anchorTaskId: task.id }, { token });
    assert.equal(listed.body.result.tasks.length, 1);
    assert.equal(listed.body.result.tasks[0].id, task.id);

    const cancelled = await app.rpc('CancelTask', { id: task.id }, { token });
    assert.equal(cancelled.body.error.code, -32002, 'a delivered hire cannot be cancelled');
  } finally { await app.close(); }
});

test('an unknown method, a push config and a subscribe to a finished task each answer their own code', async () => {
  const app = await serve();
  try {
    const unknown = await app.rpc('DoTheThing', {});
    assert.equal(unknown.body.error.code, -32601);

    const push = await app.rpc('CreateTaskPushNotificationConfig', { taskId: 'x' });
    assert.equal(push.body.error.code, -32003);

    const hired = await app.rpc('SendMessage', { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Edit this.' }] } }, { path: '/agents/copy-editor/a2a/v1' });
    const task = hired.body.result.task;
    const subscribe = await app.rpc('SubscribeToTask', { id: task.id }, { token: task.metadata['roster/hireToken'] });
    assert.equal(subscribe.body.error.code, -32004);

    const extended = await app.rpc('GetExtendedAgentCard', {});
    assert.equal(extended.body.error.code, -32007);
  } finally { await app.close(); }
});

test('SendStreamingMessage streams the task, its artifact and a final status', async () => {
  const app = await serve();
  try {
    const response = await fetch(`${app.base}/agents/copy-editor/a2a/v1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 7, method: 'SendStreamingMessage',
        params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Edit this.' }] } },
      }),
    });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    const text = await response.text();
    const frames = text.split('\n\n').filter(Boolean).map((frame) => JSON.parse(frame.replace(/^data: /, '')));
    assert.ok(frames.every((frame) => frame.jsonrpc === '2.0' && frame.id === 7));
    assert.ok(frames[0].result.task, 'the first frame is the task itself');
    assert.ok(frames.some((frame) => frame.result.artifactUpdate?.artifact?.name === 'edited-text'));
    const last = frames.at(-1).result.statusUpdate;
    assert.equal(last.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(last.final, true);
  } finally { await app.close(); }
});

test('the REST side answers 402 with both payment urls, then delivers once paid', async () => {
  const app = await serve({ prices: { 'roster.hire.briefer.small': 5_000 } });
  try {
    const quote = await app.post('/v1/hires', { agent: 'briefer', brief: 'Brief this.', model: SMALL });
    assert.equal(quote.status, 402);
    assert.equal(quote.body.hire.state, 'TASK_STATE_INPUT_REQUIRED');
    assert.match(quote.body.hire.charge.payUrl, /\/pay\//);
    assert.match(quote.body.hire.charge.paymentUrl, /\/pay$/);
    const token = quote.body.hireToken;

    app.billing.pay(quote.body.hire.charge.id, '0xrest');
    const message = await app.post(`/v1/hires/${quote.body.hire.id}/messages`, { text: 'go' }, { token });
    assert.equal(message.status, 200);
    assert.equal(message.body.hire.state, 'TASK_STATE_COMPLETED');
    assert.equal(message.body.hire.charge.payer, '0xrest');

    const read = await app.get(`/v1/hires/${quote.body.hire.id}`, { token });
    assert.equal(read.body.hire.artifacts[0].name, 'brief');
    const denied = await app.get(`/v1/hires/${quote.body.hire.id}`);
    assert.equal(denied.status, 401);
  } finally { await app.close(); }
});

test('listings and models are readable, and say plainly that a publisher earns nothing', async () => {
  const app = await serve();
  try {
    const listings = await app.get('/v1/listings');
    assert.equal(listings.body.listings.length, 5);
    assert.equal(listings.body.publishing.publisherEarns, false);
    const editor = listings.body.listings.find((l) => l.slug === 'copy-editor');
    assert.deepEqual(editor.skus, ['roster.hire.copy-editor.open', 'roster.hire.copy-editor.small', 'roster.hire.copy-editor.mid', 'roster.hire.copy-editor.frontier']);
    // The prompt that makes a listing work is not handed out with the listing.
    assert.equal(editor.instructions, undefined);
    assert.ok(editor.instructionsBytes > 100);

    const models = await app.get('/v1/models');
    assert.equal(models.body.models.length, 3);
    assert.ok(models.body.models.every((m) => m.available));
  } finally { await app.close(); }
});

test('anyone may list an agent, and it is hireable straight away', async () => {
  const app = await serve();
  try {
    const published = await app.post('/v1/listings', {
      name: 'Rhyme Checker',
      description: 'Says whether two lines rhyme, and how well.',
      instructions: 'You judge rhymes. Answer with the verdict and one line of reasoning.',
      defaultModel: SMALL,
      tiers: ['small'],
      skills: [{ id: 'rhyme', name: 'Check a rhyme', description: 'Judges whether two lines rhyme.' }],
    });
    assert.equal(published.status, 201);
    assert.equal(published.body.publisherEarns, false);
    assert.equal(published.body.listing.slug, 'rhyme-checker');
    const ownerToken = published.body.ownerToken;
    assert.ok(ownerToken);
    assert.equal(published.body.listing.ownerToken, undefined);

    const hired = await app.rpc('SendMessage', {
      message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Do "cat" and "hat" rhyme?' }] },
    }, { path: '/agents/rhyme-checker/a2a/v1' });
    assert.equal(hired.body.result.task.status.state, 'TASK_STATE_COMPLETED');

    const badWithdraw = await fetch(`${app.base}/v1/listings/rhyme-checker`, { method: 'DELETE', headers: { 'X-Roster-Hire': 'wrong' } });
    assert.equal(badWithdraw.status, 401);
    const withdraw = await fetch(`${app.base}/v1/listings/rhyme-checker`, { method: 'DELETE', headers: { 'X-Roster-Hire': ownerToken } });
    assert.equal(withdraw.status, 200);
    const gone = await app.get('/agents/rhyme-checker/.well-known/agent-card.json');
    assert.equal(gone.status, 404);
  } finally { await app.close(); }
});

test('a published listing cannot be an orchestrator, use an expensive tier, or be a house listing', async () => {
  const app = await serve();
  try {
    const tooRich = await app.post('/v1/listings', {
      name: 'Expensive', description: 'Wants the best model.',
      instructions: 'Be expensive.', defaultModel: 'anthropic/claude-opus-5', tiers: ['frontier'],
      skills: [{ id: 's', name: 'S', description: 'Something.' }],
    });
    assert.equal(tooRich.status, 400);
    assert.match(tooRich.body.error.message, /tier frontier is not one of/);

    const sneaky = await app.post('/v1/listings', {
      name: 'Foreman Two', description: 'Wants to hire others.', orchestrator: true,
      instructions: 'Hire everyone.', defaultModel: SMALL, tiers: ['small'],
      skills: [{ id: 's', name: 'S', description: 'Something.' }],
    });
    assert.equal(sneaky.status, 201);
    assert.equal(sneaky.body.listing.orchestrator, false, 'a published listing never gets to hire others');

    const withdrawHouse = await fetch(`${app.base}/v1/listings/copy-editor`, { method: 'DELETE', headers: { 'X-Roster-Hire': 'anything' } });
    assert.equal(withdrawHouse.status, 403);
  } finally { await app.close(); }
});

test('the operator view is off without a key, refuses a wrong one, and counts free work as free', async () => {
  const app = await serve();
  try {
    const off = await app.get('/v1/admin/overview');
    assert.equal(off.status, 503);
    app.config.adminToken = 'admin-secret';
    const wrong = await app.get('/v1/admin/overview', { token: 'nope' });
    assert.equal(wrong.status, 401);

    await app.post('/v1/hires', { agent: 'copy-editor', brief: 'Edit this.' });
    const overview = await app.get('/v1/admin/overview', { token: 'admin-secret' });
    assert.equal(overview.status, 200);
    assert.equal(overview.body.counts.hires, 1);
    assert.equal(overview.body.counts.freeHires, 1);
    assert.equal(overview.body.counts.paidMicro, 0);
    assert.deepEqual(overview.body.prices, []);
    assert.equal(overview.body.listings.length, 5);
  } finally { await app.close(); }
});

test('a body larger than the limit is refused rather than read', async () => {
  const app = await serve({ config: { maxRequestBytes: 2_000 } });
  try {
    const response = await fetch(`${app.base}/v1/hires`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: 'copy-editor', brief: 'x'.repeat(5_000) }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error.message, /larger than 2000 bytes/);
  } finally { await app.close(); }
});
