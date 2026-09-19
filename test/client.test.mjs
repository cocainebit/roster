import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serve, SMALL } from './helpers.mjs';
import { A2AClient, readTask } from '../src/client.mjs';
import { FakeProvider } from '../src/providers/fake.mjs';

test('a client reads the card, picks the 1.0 interface, and hires', async () => {
  const app = await serve({ provider: new FakeProvider({ reply: 'the edited line' }) });
  try {
    const client = await A2AClient.fromCardUrl(`${app.base}/agents/copy-editor/.well-known/agent-card.json`);
    assert.equal(client.dialect, 'v1');
    assert.equal(client.url, `${app.base}/agents/copy-editor/a2a/v1`);
    const task = readTask(await client.send({ text: 'Tighten this sentence for me please.' }));
    assert.equal(task.state, 'completed');
    assert.equal(task.artifacts[0].text, 'the edited line');
    assert.ok(client.hireToken, 'the client keeps the hire token it was given');

    // And can then read its own hire back with that token.
    const again = readTask(await client.get(task.id));
    assert.equal(again.id, task.id);
    assert.equal(again.usage.counted, 'provider');
  } finally { await app.close(); }
});

test('a client that speaks only 0.3 hires the same agent and reads the same result', async () => {
  const app = await serve({ provider: new FakeProvider({ reply: 'legacy answer' }) });
  try {
    const client = new A2AClient({ url: `${app.base}/agents/briefer/a2a/v0.3`, dialect: 'legacy' });
    const task = readTask(await client.send({ text: 'Brief this document for me.' }));
    assert.equal(task.state, 'completed');
    assert.equal(task.artifacts[0].text, 'legacy answer');
  } finally { await app.close(); }
});

test('a client is quoted, pays over x402 on the task, and gets the work', async () => {
  const app = await serve({ prices: { 'roster.hire.copy-editor.small': 20_000 } });
  try {
    const client = await A2AClient.fromCardUrl(`${app.base}/agents/copy-editor/.well-known/agent-card.json`);
    const quote = readTask(await client.send({ text: 'Edit this.', model: SMALL }));
    assert.equal(quote.state, 'input-required');
    assert.equal(quote.payment.status, 'payment-required');
    const accepts = quote.payment.required.accepts[0];
    assert.equal(accepts.network, 'eip155:84532');

    // A wallet would sign the requirements here. The fake payment service takes any payload.
    const paid = readTask(await client.send({ taskId: quote.id, text: 'payment attached', payment: { payload: { x402Version: 2, payer: '0xclient' } } }));
    assert.equal(paid.state, 'completed');
    assert.equal(paid.payment.status, 'payment-completed');
    assert.equal(paid.payment.receipts.length, 1);
  } finally { await app.close(); }
});

test('a client can reject a quote, and nothing is charged', async () => {
  const app = await serve({ prices: { 'roster.hire.copy-editor.small': 20_000 } });
  try {
    const client = await A2AClient.fromCardUrl(`${app.base}/agents/copy-editor/.well-known/agent-card.json`);
    const quote = readTask(await client.send({ text: 'Edit this.', model: SMALL }));
    const rejected = readTask(await client.send({ taskId: quote.id, text: 'too expensive', payment: { rejected: true } }));
    assert.equal(rejected.state, 'rejected');
    assert.equal(app.provider.calls.length, 0);
  } finally { await app.close(); }
});

test('a client streams a hire and sees the artifact arrive before the final status', async () => {
  const app = await serve({ provider: new FakeProvider({ reply: 'streamed answer' }) });
  try {
    const client = await A2AClient.fromCardUrl(`${app.base}/agents/copy-editor/.well-known/agent-card.json`);
    const seen = [];
    for await (const event of client.stream({ text: 'Edit this while I watch.' })) {
      if (event.task) seen.push(`task:${event.task.status.state}`);
      if (event.statusUpdate) seen.push(`status:${event.statusUpdate.status.state}`);
      if (event.artifactUpdate) seen.push(`artifact:${event.artifactUpdate.artifact.name}`);
    }
    assert.ok(seen[0].startsWith('task:'));
    assert.ok(seen.includes('artifact:edited-text'));
    assert.equal(seen.at(-1), 'status:TASK_STATE_COMPLETED');
    assert.ok(seen.indexOf('artifact:edited-text') < seen.length - 1);
  } finally { await app.close(); }
});

test('an agent hires an agent: the foreman subcontracts over the hall it is hired through', async () => {
  const provider = new FakeProvider({
    replies: [
      JSON.stringify({ hires: [{ agent: 'briefer', brief: 'Brief this: the ports document.' }], why: 'a brief first' }),
      'the brief of the ports document',
      'my synthesis, on top of the brief',
    ],
  });
  const app = await serve({ provider });
  try {
    const client = await A2AClient.fromCardUrl(`${app.base}/agents/foreman/.well-known/agent-card.json`);
    const task = readTask(await client.send({ text: 'Brief this document and tell me what you make of it.' }));
    assert.equal(task.state, 'completed');
    assert.deepEqual(task.artifacts.map((a) => a.name), ['briefer/brief', 'synthesis']);
    assert.equal(task.artifacts[1].text, 'my synthesis, on top of the brief');
  } finally { await app.close(); }
});

test('a client is told plainly when the agent it asked for does not exist', async () => {
  const app = await serve();
  try {
    await assert.rejects(
      () => A2AClient.fromCardUrl(`${app.base}/agents/nobody/.well-known/agent-card.json`),
      /HTTP 404/,
    );
    const client = new A2AClient({ url: `${app.base}/agents/nobody/a2a/v1` });
    await assert.rejects(() => client.send({ text: 'hello' }), (error) => error.rpcCode === -32602);
  } finally { await app.close(); }
});
