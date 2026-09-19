import { test } from 'node:test';
import assert from 'node:assert/strict';
import { harness, SMALL } from './helpers.mjs';
import { taskView, streamEvent, parseSendParams, listingCard, hallCard, METHODS, A2A_ERROR } from '../src/a2a.mjs';
import { EXTENSION_URI, X402_EXTENSION_URI } from '../src/hall.mjs';

test('a task in A2A 1.0 uses proto enum names, untagged parts and no kind field', async () => {
  const { hall, models } = harness();
  const { hire } = await hall.hire({ slug: 'copy-editor', text: 'Edit this.' });
  const task = taskView(hire, 'v1', { includeToken: true });
  assert.equal(task.kind, undefined);
  assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
  assert.equal(task.history[0].role, 'ROLE_USER');
  assert.equal(task.history[0].kind, undefined);
  assert.equal(task.artifacts[0].parts[0].kind, undefined);
  assert.equal(typeof task.artifacts[0].parts[0].text, 'string');
  assert.equal(task.artifacts[0].parts[0].mediaType, 'text/plain');
  assert.match(task.status.timestamp, /^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(task.metadata['roster/hireToken'], hire.token);
  assert.equal(task.metadata['roster/model'], 'anthropic/claude-haiku-4-5-20251001');
  assert.ok(models);
});

test('the same task in A2A 0.3 uses lowercase states, tagged parts and kind fields', async () => {
  const { hall } = harness();
  const { hire } = await hall.hire({ slug: 'copy-editor', text: 'Edit this.' });
  const task = taskView(hire, 'legacy');
  assert.equal(task.kind, 'task');
  assert.equal(task.status.state, 'completed');
  assert.equal(task.history[0].role, 'user');
  assert.equal(task.history[0].kind, 'message');
  assert.equal(task.artifacts[0].parts[0].kind, 'text');
});

test('a data artifact travels as a data part in both dialects', async () => {
  const { hall } = harness({ provider: new (await import('../src/providers/fake.mjs')).FakeProvider({ reply: '{"total": 3}' }) });
  const { hire } = await hall.hire({ slug: 'extractor', text: 'Pull the total: 3' });
  assert.deepEqual(taskView(hire, 'v1').artifacts[0].parts[0].data, { total: 3 });
  const legacy = taskView(hire, 'legacy').artifacts[0].parts[0];
  assert.equal(legacy.kind, 'data');
  assert.deepEqual(legacy.data, { total: 3 });
});

test('a hire waiting for payment carries the x402 extension metadata on its status message', async () => {
  const { hall } = harness({ prices: { 'roster.hire.copy-editor.small': 20_000 } });
  const { hire } = await hall.hire({ slug: 'copy-editor', text: 'Edit this.', model: SMALL });
  for (const dialect of ['v1', 'legacy']) {
    const task = taskView(hire, dialect);
    const metadata = task.status.message.metadata;
    assert.equal(task.status.state, dialect === 'v1' ? 'TASK_STATE_INPUT_REQUIRED' : 'input-required');
    assert.equal(metadata['x402.payment.status'], 'payment-required');
    assert.equal(metadata['x402.payment.required'].x402Version, 2);
    assert.equal(metadata['x402.payment.required'].accepts[0].payTo, '0xhouse');
    assert.equal(task.metadata['roster/charge'].status, 'open');
  }
});

test('receipts accumulate on the task rather than replacing each other', async () => {
  const { hall } = harness({ prices: { 'roster.hire.copy-editor.small': 20_000 } });
  const { hire } = await hall.hire({ slug: 'copy-editor', text: 'Edit this.', model: SMALL });
  await hall.send({ id: hire.id, payment: { status: 'payment-submitted', payload: { bad: true } } });
  await hall.send({ id: hire.id, payment: { status: 'payment-submitted', payload: { payer: '0xok' } } });
  const receipts = taskView(hall.get(hire.id), 'v1').status.message.metadata['x402.payment.receipts'];
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].success, false);
  assert.equal(receipts[1].success, true);
});

test('stream events are wrapped in 1.0 and tagged in 0.3, and the terminal one is final', async () => {
  const { hall } = harness();
  const { hire } = await hall.hire({ slug: 'copy-editor', text: 'Edit this.' });
  const v1 = streamEvent(hire, 'v1');
  assert.ok(v1.statusUpdate);
  assert.equal(v1.statusUpdate.final, true);
  assert.equal(v1.statusUpdate.taskId, hire.id);
  const legacy = streamEvent(hire, 'legacy');
  assert.equal(legacy.kind, 'status-update');
  assert.equal(legacy.final, true);
  const artifactEvent = streamEvent(hire, 'v1', { artifact: hire.artifacts[0] });
  assert.equal(artifactEvent.artifactUpdate.lastChunk, true);
  assert.equal(artifactEvent.artifactUpdate.artifact.name, 'edited-text');
});

test('model and skill choice is read from the extension metadata or the plain key', () => {
  const viaExtension = parseSendParams({
    message: { parts: [{ text: 'hello' }], metadata: { [EXTENSION_URI]: { model: 'anthropic/claude-opus-5', skill: 'edit', agent: 'copy-editor' } } },
  }, { dialect: 'v1' });
  assert.equal(viaExtension.model, 'anthropic/claude-opus-5');
  assert.equal(viaExtension.skill, 'edit');
  assert.equal(viaExtension.agent, 'copy-editor');

  const viaPlainKey = parseSendParams({
    message: { parts: [{ kind: 'text', text: 'hello' }], metadata: { 'roster/model': 'anthropic/claude-sonnet-5' } },
  }, { dialect: 'legacy' });
  assert.equal(viaPlainKey.model, 'anthropic/claude-sonnet-5');
  assert.equal(viaPlainKey.text, 'hello');
});

test('both part dialects parse, and a file part is refused rather than silently dropped', () => {
  const both = parseSendParams({ message: { parts: [{ kind: 'text', text: 'a' }, { data: { b: 1 } }] } }, { dialect: 'legacy' });
  assert.equal(both.text, 'a');
  assert.deepEqual(both.data, { b: 1 });
  assert.throws(
    () => parseSendParams({ message: { parts: [{ kind: 'file', file: { name: 'x.pdf' } }] } }, { dialect: 'legacy' }),
    (error) => error.code === 'content_type_not_supported',
  );
});

test('a payment payload in message metadata is understood in both dialects', () => {
  const parsed = parseSendParams({
    message: { taskId: 't1', parts: [{ text: 'here is the payment' }], metadata: { 'x402.payment.status': 'payment-submitted', 'x402.payment.payload': { x402Version: 2 } } },
  }, { dialect: 'legacy' });
  assert.equal(parsed.taskId, 't1');
  assert.equal(parsed.payment.status, 'payment-submitted');
  assert.equal(parsed.payment.payload.x402Version, 2);
});

test('a listing card declares both interfaces, both extensions, and only models that work here', () => {
  const { catalog, models } = harness({ extraModels: ['openai/gpt-x=frontier'] });
  const card = listingCard(catalog.get('copy-editor'), { publicUrl: 'http://127.0.0.1:8810', models });
  assert.equal(card.protocolVersion, '1.0');
  assert.deepEqual(card.supportedInterfaces.map((i) => i.protocolVersion), ['1.0', '0.3']);
  assert.equal(card.supportedInterfaces[0].url, 'http://127.0.0.1:8810/agents/copy-editor/a2a/v1');
  assert.equal(card.supportedInterfaces[0].protocolBinding, 'JSONRPC');
  // Legacy fields for a 0.3 client reading the same document.
  assert.equal(card.url, 'http://127.0.0.1:8810/agents/copy-editor/a2a/v0.3');
  assert.equal(card.preferredTransport, 'JSONRPC');
  assert.equal(card.capabilities.pushNotifications, false);
  assert.deepEqual(card.capabilities.extensions.map((e) => e.uri), [X402_EXTENSION_URI, EXTENSION_URI]);
  assert.ok(card.skills.length >= 2);
  // openai/gpt-x is declared at frontier but has no credential here, so it is listed as unavailable
  // with a reason rather than offered.
  assert.ok(card.metadata['roster/models'].every((m) => m.key.startsWith('anthropic/')));
  assert.equal(card.metadata['roster/modelsUnavailable'][0].key, 'openai/gpt-x');
  assert.match(card.metadata['roster/modelsUnavailable'][0].reason, /no credential/);
  assert.equal(card.metadata['roster/listing'].skuPattern, 'roster.hire.copy-editor.<tier>');
});

test('the hall card lists every agent as a skill of its own', () => {
  const { catalog, models } = harness();
  const card = hallCard({ listings: catalog.list(), publicUrl: 'http://127.0.0.1:8810', models });
  assert.equal(card.name, 'Roster');
  assert.ok(card.skills.some((skill) => skill.id === 'copy-editor:edit'));
  assert.ok(card.metadata['roster/listings'].some((l) => l.slug === 'foreman'));
});

test('both dialects of every method are routed, and the method decides the dialect', () => {
  assert.equal(METHODS.get('SendMessage').dialect, 'v1');
  assert.equal(METHODS.get('message/send').dialect, 'legacy');
  assert.equal(METHODS.get('message/send').op, METHODS.get('SendMessage').op);
  assert.equal(METHODS.get('tasks/resubscribe').op, METHODS.get('SubscribeToTask').op);
  assert.equal(A2A_ERROR.taskNotFound, -32001);
  assert.equal(A2A_ERROR.unsupportedOperation, -32004);
});
