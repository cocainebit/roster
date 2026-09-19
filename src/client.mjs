import { X402_EXTENSION_URI, EXTENSION_URI } from './hall.mjs';

// An A2A client, because the point of a hall is that agents hire from it. It reads a card, picks the
// interface it can speak, and hires. Speaks A2A 1.0 and falls back to 0.3 when a card offers only that,
// so a foreman here can hire outside this house without knowing which dialect a stranger serves.
export class A2AClient {
  #fetch;
  constructor({ card, url, dialect = 'v1', extensions = [X402_EXTENSION_URI, EXTENSION_URI], fetchImpl = fetch, hireToken = null } = {}) {
    this.card = card ?? null; this.url = url; this.dialect = dialect; this.extensions = extensions;
    this.#fetch = fetchImpl; this.hireToken = hireToken;
    this.id = 0;
  }

  static async fromCardUrl(cardUrl, options = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(cardUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Could not read an agent card at ${cardUrl}: HTTP ${response.status}`);
    const card = await response.json();
    const interfaces = Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : [];
    const jsonrpc = interfaces.filter((i) => (i.protocolBinding ?? '').toUpperCase() === 'JSONRPC');
    const preferred = jsonrpc.find((i) => (i.protocolVersion ?? '').startsWith('1.')) ?? jsonrpc[0];
    if (preferred) {
      return new A2AClient({ ...options, card, url: preferred.url, dialect: (preferred.protocolVersion ?? '').startsWith('1.') ? 'v1' : 'legacy', fetchImpl });
    }
    // A 0.3 card: one url, no interface list.
    if (typeof card.url === 'string') return new A2AClient({ ...options, card, url: card.url, dialect: 'legacy', fetchImpl });
    throw new Error(`The card at ${cardUrl} offers no JSON-RPC interface this client can speak`);
  }

  #method(name) {
    const v1 = { send: 'SendMessage', stream: 'SendStreamingMessage', get: 'GetTask', cancel: 'CancelTask', subscribe: 'SubscribeToTask' };
    const legacy = { send: 'message/send', stream: 'message/stream', get: 'tasks/get', cancel: 'tasks/cancel', subscribe: 'tasks/resubscribe' };
    return (this.dialect === 'v1' ? v1 : legacy)[name];
  }

  async #call(method, params, { stream = false } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json' };
    if (this.extensions.length) headers['X-A2A-Extensions'] = this.extensions.join(', ');
    if (this.hireToken) headers['X-Roster-Hire'] = this.hireToken;
    const response = await this.#fetch(this.url, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      signal: AbortSignal.timeout(stream ? 600_000 : 300_000),
    });
    if (stream) return response;
    const body = await response.json();
    if (body.error) {
      throw Object.assign(new Error(body.error.message ?? 'the agent refused'), { rpcCode: body.error.code, data: body.error.data });
    }
    return body.result;
  }

  #message({ text, data = null, taskId = null, contextId = null, model = null, skill = null, agent = null, payment = null }) {
    const parts = [];
    if (text) parts.push(this.dialect === 'v1' ? { text } : { kind: 'text', text });
    if (data !== null && data !== undefined) parts.push(this.dialect === 'v1' ? { data } : { kind: 'data', data });
    const metadata = {};
    const ours = {};
    if (model) ours.model = model;
    if (skill) ours.skill = skill;
    if (agent) ours.agent = agent;
    if (Object.keys(ours).length) metadata[EXTENSION_URI] = ours;
    if (payment?.payload) {
      metadata['x402.payment.status'] = 'payment-submitted';
      metadata['x402.payment.payload'] = payment.payload;
    }
    if (payment?.rejected) metadata['x402.payment.status'] = 'payment-rejected';
    return {
      messageId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      role: this.dialect === 'v1' ? 'ROLE_USER' : 'user',
      ...(this.dialect === 'legacy' ? { kind: 'message' } : {}),
      parts,
      ...(taskId ? { taskId } : {}),
      ...(contextId ? { contextId } : {}),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    };
  }

  // Returns the task as the server sent it, in whichever dialect this client speaks, unwrapped from
  // 1.0's oneof so a caller sees one shape.
  #unwrap(result) { return result?.task ?? result; }

  async send(options) {
    const params = { message: this.#message(options) };
    if (options.returnImmediately || options.historyLength !== undefined) {
      params.configuration = {
        ...(options.returnImmediately ? { returnImmediately: true } : {}),
        ...(options.historyLength !== undefined ? { historyLength: options.historyLength } : {}),
      };
    }
    const task = this.#unwrap(await this.#call(this.#method('send'), params));
    const token = task?.metadata?.['roster/hireToken'];
    if (token) this.hireToken = token;
    return task;
  }

  async get(id, { historyLength } = {}) {
    return this.#unwrap(await this.#call(this.#method('get'), { id, ...(historyLength === undefined ? {} : { historyLength }) }));
  }

  async cancel(id) { return this.#unwrap(await this.#call(this.#method('cancel'), { id })); }

  // Each SSE frame is a JSON-RPC response whose result is a task, a message, or a status or artifact
  // update. Yielded as they arrive.
  async *stream(options) {
    const params = { message: this.#message(options) };
    const response = await this.#call(this.#method('stream'), params, { stream: true });
    if (!response.ok || !response.body) throw new Error(`stream failed: HTTP ${response.status}`);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let split;
      while ((split = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const body = JSON.parse(line.slice(5).trim());
          if (body.error) throw Object.assign(new Error(body.error.message), { rpcCode: body.error.code });
          const token = body.result?.task?.metadata?.['roster/hireToken'] ?? body.result?.metadata?.['roster/hireToken'];
          if (token) this.hireToken = token;
          yield body.result;
        }
      }
    }
  }
}

// What a buyer's own code needs out of a task, in both dialects.
export function readTask(task) {
  const state = task?.status?.state ?? null;
  const normalized = typeof state === 'string' && state.startsWith('TASK_STATE_')
    ? state.slice('TASK_STATE_'.length).toLowerCase().replace(/_/g, '-')
    : state;
  const statusMessage = task?.status?.message;
  const metadata = statusMessage?.metadata ?? {};
  return {
    id: task?.id,
    contextId: task?.contextId,
    state: normalized,
    text: (statusMessage?.parts ?? []).map((p) => p.text).filter(Boolean).join('\n'),
    artifacts: (task?.artifacts ?? []).map((artifact) => ({
      name: artifact.name,
      text: (artifact.parts ?? []).map((p) => p.text).filter(Boolean).join('\n'),
      data: (artifact.parts ?? []).find((p) => p.data !== undefined)?.data ?? null,
    })),
    payment: metadata['x402.payment.status']
      ? {
        status: metadata['x402.payment.status'],
        required: metadata['x402.payment.required'] ?? null,
        receipts: metadata['x402.payment.receipts'] ?? [],
        error: metadata['x402.payment.error'] ?? null,
      }
      : null,
    charge: task?.metadata?.['roster/charge'] ?? null,
    usage: task?.metadata?.['roster/usage'] ?? null,
    hireToken: task?.metadata?.['roster/hireToken'] ?? null,
  };
}
