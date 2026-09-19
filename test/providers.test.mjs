import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { AnthropicProvider } from '../src/providers/anthropic.mjs';
import { OpenAICompatibleProvider } from '../src/providers/openai.mjs';
import { GoogleProvider } from '../src/providers/google.mjs';
import { InstanceComputeProvider } from '../src/providers/instance.mjs';

// Every provider adapter is checked over real HTTP against a stub that answers the way that vendor's
// API answers. No model has answered a real request here (there is no key on this machine), so what is
// proven is the wire format, not the model.
async function stub(handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    handler({ req, res, body, seen });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const reply = (res, status, value) => {
    const payload = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  };
  return {
    seen, reply,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}

test('the Anthropic adapter sends the system prompt as its own field and reads its usage', async () => {
  let s;
  s = await stub(({ res, body }) => {
    assert.equal(body.model, 'claude-haiku-4-5-20251001');
    assert.equal(body.system, 'be brief');
    assert.equal(body.max_tokens, 100);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
    s.reply(res, 200, {
      content: [{ type: 'thinking', thinking: 'ignored' }, { type: 'text', text: 'hi' }],
      usage: { input_tokens: 11, output_tokens: 2 }, stop_reason: 'end_turn',
    });
  });
  try {
    const provider = new AnthropicProvider({ baseUrl: s.base, apiKey: 'test-key' });
    const answer = await provider.chat({ model: 'claude-haiku-4-5-20251001', system: 'be brief', messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 100 });
    assert.equal(answer.text, 'hi');
    assert.deepEqual(answer.usage, { inputTokens: 11, outputTokens: 2, counted: 'provider' });
    assert.equal(s.seen[0].url, '/v1/messages');
    assert.equal(s.seen[0].headers['x-api-key'], 'test-key');
    assert.equal(s.seen[0].headers['anthropic-version'], '2023-06-01');
  } finally { await s.close(); }
});

test('an OpenAI-compatible server is read for content and usage, and a missing count says estimated', async () => {
  let s;
  s = await stub(({ res, body }) => {
    assert.deepEqual(body.messages[0], { role: 'system', content: 'be brief' });
    s.reply(res, 200, { choices: [{ message: { content: 'hello there' }, finish_reason: 'stop' }] });
  });
  try {
    const provider = new OpenAICompatibleProvider({ baseUrl: s.base, apiKey: 'sk-test' });
    const answer = await provider.chat({ model: 'some-model', system: 'be brief', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 10 });
    assert.equal(answer.text, 'hello there');
    assert.equal(answer.usage.counted, 'estimated', 'a server that reports no usage must not be presented as measured');
    assert.ok(answer.usage.outputTokens > 0);
    assert.equal(s.seen[0].url, '/v1/chat/completions');
    assert.equal(s.seen[0].headers.authorization, 'Bearer sk-test');
  } finally { await s.close(); }
});

test('a provider failure carries its status and body, and is labelled as ours', async () => {
  let s;
  s = await stub(({ res }) => s.reply(res, 429, { error: { message: 'slow down' } }));
  try {
    const provider = new OpenAICompatibleProvider({ baseUrl: s.base, apiKey: 'sk-test' });
    await assert.rejects(
      () => provider.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 5 }),
      (error) => error.code === 'provider_failed' && /HTTP 429/.test(error.message) && /slow down/.test(error.message),
    );
  } finally { await s.close(); }
});

test('the Gemini adapter maps roles and reads usageMetadata', async () => {
  let s;
  s = await stub(({ res, body }) => {
    assert.equal(body.systemInstruction.parts[0].text, 'be brief');
    assert.deepEqual(body.contents.map((c) => c.role), ['user', 'model', 'user']);
    s.reply(res, 200, {
      candidates: [{ content: { parts: [{ text: 'an' }, { text: 'swer' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
    });
  });
  try {
    const provider = new GoogleProvider({ baseUrl: s.base, apiKey: 'goog-key' });
    const answer = await provider.chat({
      model: 'gemini-x', system: 'be brief', maxOutputTokens: 20,
      messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }],
    });
    assert.equal(answer.text, 'answer');
    assert.deepEqual(answer.usage, { inputTokens: 7, outputTokens: 3, counted: 'provider' });
    assert.match(s.seen[0].url, /\/v1beta\/models\/gemini-x:generateContent$/);
    assert.equal(s.seen[0].headers['x-goog-api-key'], 'goog-key');
  } finally { await s.close(); }
});

test('the instanceOS compute adapter buys a bundle, spends it, and buys again when it runs out', async () => {
  let spent = 0;
  let s;
  s = await stub(({ res, url = '', body, req }) => {
    if (req.url === '/v1/bundles') {
      return s.reply(res, 201, { bundle: { id: `b${s.seen.length}`, bundleToken: `bt${s.seen.length}`, tokens: 1_000, status: 'ready' } });
    }
    if (req.url === '/v1/inference/chat') {
      spent += 1;
      if (spent === 2) return s.reply(res, 402, { error: { code: 'bundle_spent', message: 'This bundle is spent' } });
      return s.reply(res, 200, { content: 'open weights answer', usage: { promptTokens: 5, completionTokens: 6, counted: 'server' } });
    }
    return s.reply(res, 404, { error: { code: 'not_found', message: url } });
  });
  try {
    const provider = new InstanceComputeProvider({ baseUrl: s.base, bundleTokens: 1_000 });
    const first = await provider.chat({ model: 'llama70b', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 50 });
    assert.equal(first.text, 'open weights answer');
    assert.deepEqual(first.usage, { inputTokens: 5, outputTokens: 6, counted: 'provider' });
    const chatCall = s.seen.find((call) => call.url === '/v1/inference/chat');
    assert.equal(chatCall.headers.authorization, 'Bearer bt1');
    assert.equal(chatCall.body.bundle, 'b1');

    // The second request finds the bundle spent, buys another, and answers.
    const second = await provider.chat({ model: 'llama70b', messages: [{ role: 'user', content: 'again' }], maxOutputTokens: 50 });
    assert.equal(second.text, 'open weights answer');
    assert.equal(s.seen.filter((call) => call.url === '/v1/bundles').length, 2);
  } finally { await s.close(); }
});

test('when compute wants paying for a bundle, the adapter stops and says so rather than retrying', async () => {
  let s;
  s = await stub(({ res }) => s.reply(res, 402, { error: { code: 'payment_required', message: 'pay first' }, bundle: { payUrl: 'http://pay/here' } }));
  try {
    const provider = new InstanceComputeProvider({ baseUrl: s.base });
    await assert.rejects(
      () => provider.chat({ model: 'llama70b', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 10 }),
      (error) => error.code === 'provider_unpaid' && /http:\/\/pay\/here/.test(error.message),
    );
  } finally { await s.close(); }
});
