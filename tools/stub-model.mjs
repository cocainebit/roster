// A local OpenAI-compatible model server, for verifying the whole path without a provider key. It
// answers like a model, counts tokens like a server that reports usage, and invents nothing: what it
// returns is plainly a stub, so no output of this can be mistaken for a model's work.
import { createServer } from 'node:http';

const port = Number(process.env.STUB_PORT ?? 8811);
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: `nothing at ${req.url}` } }));
  }
  const last = (body.messages ?? []).at(-1)?.content ?? '';
  // The foreman asks for a plan as JSON first, so a stub that cannot answer JSON cannot exercise it.
  // Matched on the plan request alone: matching the system prompt too would make every answer JSON.
  const wantsJson = /Answer with the plan JSON only/.test(last);
  const content = wantsJson
    ? JSON.stringify({ hires: [{ agent: 'briefer', brief: `Brief this: ${last.slice(0, 200)}` }], why: 'stub plan' })
    : `STUB MODEL ANSWER (${last.length} characters of brief, ${body.max_tokens} token ceiling)`;
  const payload = JSON.stringify({
    id: 'stub', object: 'chat.completion', model: body.model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: Math.ceil(JSON.stringify(body.messages).length / 4), completion_tokens: Math.ceil(content.length / 4), total_tokens: 0 },
  });
  res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
});
server.listen(port, '127.0.0.1', () => console.log(`stub model server on http://127.0.0.1:${port} (OpenAI-compatible)`));
