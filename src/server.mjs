import { createServer } from 'node:http';
import { loadConfig } from './config.mjs';
import { PlatformBilling, UnmeteredBilling, PaymentUnavailable, BillingError } from './billing.mjs';
import { Catalog, skuFor } from './catalog.mjs';
import { ModelRouter } from './models.mjs';
import { Hall, isTerminal, EXTENSION_URI, X402_EXTENSION_URI } from './hall.mjs';
import { HallStore, NullStore } from './store.mjs';
import { AnthropicProvider } from './providers/anthropic.mjs';
import { OpenAICompatibleProvider } from './providers/openai.mjs';
import { GoogleProvider } from './providers/google.mjs';
import { InstanceComputeProvider } from './providers/instance.mjs';
import {
  METHODS, A2A_ERROR, taskView, taskPayload, streamEvent, parseSendParams, listingCard, hallCard,
} from './a2a.mjs';
import { fileURLToPath } from 'node:url';

export function buildBilling(config) {
  if (config.billing === 'unmetered') {
    console.warn('WARNING: ROSTER_BILLING=unmetered. Every hire is free. Development only.');
    return new UnmeteredBilling();
  }
  return new PlatformBilling({ baseUrl: config.platformUrl, secret: config.platformSecret });
}

// A provider with no credential is simply absent, and every model behind it reads as unavailable with
// the reason. Nothing is sold that would fail on the first call.
export function buildProviders(config) {
  const providers = {};
  if (config.anthropicKey) providers.anthropic = new AnthropicProvider({ baseUrl: config.anthropicUrl, apiKey: config.anthropicKey });
  if (config.openaiKey) providers.openai = new OpenAICompatibleProvider({ baseUrl: config.openaiUrl, apiKey: config.openaiKey });
  if (config.googleKey) providers.google = new GoogleProvider({ baseUrl: config.googleUrl, apiKey: config.googleKey });
  if (config.openrouterKey) providers.openrouter = new OpenAICompatibleProvider({ baseUrl: config.openrouterUrl, apiKey: config.openrouterKey });
  if (config.instanceUrl) providers.instance = new InstanceComputeProvider({ baseUrl: config.instanceUrl });
  return providers;
}

const json = (res, status, body, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
};

// One table from our own error codes to both surfaces, so REST and JSON-RPC never disagree about what
// a failure means.
const FAILURES = {
  task_not_found: { http: 404, rpc: A2A_ERROR.taskNotFound },
  not_found: { http: 404, rpc: A2A_ERROR.invalidParams },
  not_cancelable: { http: 409, rpc: A2A_ERROR.taskNotCancelable },
  unsupported_operation: { http: 409, rpc: A2A_ERROR.unsupportedOperation },
  content_type_not_supported: { http: 415, rpc: A2A_ERROR.contentTypeNotSupported },
  invalid_request: { http: 400, rpc: A2A_ERROR.invalidParams },
  unauthorized: { http: 401, rpc: A2A_ERROR.invalidRequest },
  forbidden: { http: 403, rpc: A2A_ERROR.invalidRequest },
  payment_required: { http: 402, rpc: A2A_ERROR.unsupportedOperation },
  at_capacity: { http: 503, rpc: A2A_ERROR.unsupportedOperation },
  payment_unavailable: { http: 503, rpc: A2A_ERROR.unsupportedOperation },
  model_unavailable: { http: 503, rpc: A2A_ERROR.unsupportedOperation },
  provider_failed: { http: 502, rpc: A2A_ERROR.invalidAgentResponse },
  provider_unpaid: { http: 503, rpc: A2A_ERROR.unsupportedOperation },
  budget_spent: { http: 409, rpc: A2A_ERROR.unsupportedOperation },
};

function failureFor(error) {
  if (error instanceof PaymentUnavailable) return { ...FAILURES.payment_unavailable, code: 'payment_unavailable' };
  const code = error.code ?? (error instanceof BillingError ? 'invalid_request' : 'internal');
  return { ...(FAILURES[code] ?? { http: 500, rpc: A2A_ERROR.internal }), code };
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error(`Request body is larger than ${limit} bytes`), { code: 'invalid_request' });
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const bearer = (req) => (req.headers['x-roster-hire'] ?? (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') ?? '').toString();
// Some A2A clients, the official JS SDK among them, cannot put a custom header on one call, so the
// hire token is also read from the request's own metadata. The header is preferred: a header does not
// end up in a task's history.
const tokenFrom = (req, params = {}) => bearer(req)
  || (params.metadata?.['roster/hireToken'] ?? params.message?.metadata?.['roster/hireToken'] ?? '').toString();

export function createApp({ hall, catalog, models, config }) {
  // Read per request, not captured: a deployment (and a test on an ephemeral port) can learn its own
  // url after the app is built.
  const publicUrl = () => config.publicUrl;

  const activatedExtensions = (req) => {
    const asked = (req.headers['x-a2a-extensions'] ?? req.headers['a2a-extensions'] ?? '').toString();
    const wanted = asked.split(',').map((s) => s.trim()).filter(Boolean);
    const ours = new Set([X402_EXTENSION_URI, EXTENSION_URI]);
    const echo = wanted.filter((uri) => ours.has(uri));
    return echo.length ? { 'X-A2A-Extensions': echo.join(', ') } : {};
  };

  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const callerAddress = req.socket.remoteAddress ?? null;
    const extraHeaders = activatedExtensions(req);

    try {
      if (req.method === 'GET' && path === '/healthz') {
        return json(res, 200, {
          ok: true,
          billing: config.billing,
          platformUrl: config.platformUrl,
          listings: catalog.list().length,
          models: models.list().filter((m) => m.available).length,
          modelsDeclared: models.list().length,
          publishing: config.publishing,
          maxConcurrentHires: config.maxConcurrentHires,
          protocols: ['a2a/1.0 (JSONRPC)', 'a2a/0.3 (JSONRPC)'],
        });
      }

      // ------------------------------------------------------------ discovery
      if (req.method === 'GET' && (path === '/.well-known/agent-card.json' || path === '/.well-known/agent.json')) {
        return json(res, 200, hallCard({ listings: catalog.list(), publicUrl: publicUrl(), models }));
      }

      const listingCardMatch = path.match(/^\/agents\/([^/]+)\/(?:\.well-known\/agent-card\.json|card\.json)$/);
      if (req.method === 'GET' && listingCardMatch) {
        return json(res, 200, listingCard(catalog.get(listingCardMatch[1]), { publicUrl: publicUrl(), models }));
      }

      // ----------------------------------------------------------- A2A binding
      const rpcMatch = path.match(/^(?:\/agents\/([^/]+))?\/a2a\/(v1|v0\.3)$/);
      if (rpcMatch) {
        if (req.method !== 'POST') return json(res, 405, { error: { code: 'invalid_request', message: 'A2A calls are POSTed' } }, extraHeaders);
        return rpc(req, res, { slug: rpcMatch[1] ?? null, extraHeaders, callerAddress });
      }

      // ------------------------------------------------------- our own REST
      if (req.method === 'GET' && path === '/v1/models') {
        return json(res, 200, { models: models.list(), tiers: ['open', 'small', 'mid', 'frontier'] });
      }

      if (req.method === 'GET' && path === '/v1/listings') {
        return json(res, 200, {
          listings: catalog.list().map((listing) => ({
            ...catalog.view(listing),
            card: `${publicUrl()}/agents/${listing.slug}/.well-known/agent-card.json`,
            skus: listing.tiers.map((tier) => skuFor(listing, tier)),
            hireableOn: models.list().filter((m) => listing.tiers.includes(m.tier) && m.available).map((m) => m.key),
          })),
          // Said plainly rather than implied: a publisher earns nothing here yet.
          publishing: {
            open: config.publishing === 'on',
            publisherEarns: false,
            note: 'A published listing earns its publisher nothing today. Paying a third party out of money we collected needs the owner\'s decision first: see DESIGN.md.',
          },
        });
      }

      if (req.method === 'POST' && path === '/v1/listings') {
        const body = await readBody(req, config.maxRequestBytes);
        const { listing, ownerToken } = catalog.publish(body, { publishedBy: callerAddress });
        return json(res, 201, {
          listing, ownerToken,
          card: `${publicUrl()}/agents/${listing.slug}/.well-known/agent-card.json`,
          publisherEarns: false,
        });
      }

      const withdrawMatch = path.match(/^\/v1\/listings\/([^/]+)$/);
      if (withdrawMatch && req.method === 'DELETE') {
        return json(res, 200, catalog.withdraw(withdrawMatch[1], bearer(req)));
      }

      if (req.method === 'POST' && path === '/v1/hires') {
        const body = await readBody(req, config.maxRequestBytes);
        const { hire, hireToken } = await hall.hire({
          slug: body.agent ?? body.slug, text: body.brief ?? body.text ?? '', data: body.data ?? null,
          model: body.model ?? null, skill: body.skill ?? null, contextId: body.contextId ?? null,
          returnImmediately: body.returnImmediately === true, callerAddress,
        });
        const view = hireView(hire, hireToken);
        if (hire.charge && hire.charge.status !== 'paid') return json(res, 402, view, extraHeaders);
        return json(res, 201, view, extraHeaders);
      }

      const hireMatch = path.match(/^\/v1\/hires\/([^/]+)(\/messages|\/cancel|\/refresh)?$/);
      if (hireMatch) {
        const [, id, action] = hireMatch;
        if (req.method === 'GET' && !action) {
          hall.authorize(id, bearer(req));
          await hall.refresh(id);
          return json(res, 200, hireView(hall.get(id)), extraHeaders);
        }
        if (req.method === 'POST' && action === '/messages') {
          const body = await readBody(req, config.maxRequestBytes);
          const hire = await hall.send({
            id, text: body.text ?? '', data: body.data ?? null,
            payment: body.payment ?? null, tokenPresented: bearer(req),
            returnImmediately: body.returnImmediately === true,
          });
          return json(res, 200, hireView(hire), extraHeaders);
        }
        if (req.method === 'POST' && action === '/cancel') {
          return json(res, 200, hireView(await hall.cancel(id, bearer(req))), extraHeaders);
        }
      }

      // --------------------------------------------------------------- admin
      if (req.method === 'GET' && path === '/v1/admin/overview') {
        if (!config.adminToken) return json(res, 503, { error: { code: 'admin_disabled', message: 'Set ROSTER_ADMIN_TOKEN to use the operator view, then restart' } });
        if (bearer(req) !== config.adminToken) return json(res, 401, { error: { code: 'unauthorized', message: 'That is not the admin token for this deployment' } });
        let prices = null;
        let pricesError = null;
        try { prices = (await hall.billing.prices()).prices ?? []; } catch (error) { pricesError = error.message; }
        return json(res, 200, {
          now: Date.now(),
          deployment: {
            billing: config.billing, platformUrl: config.platformUrl, publishing: config.publishing,
            maxConcurrentHires: config.maxConcurrentHires, maxConcurrentPerOrg: config.maxConcurrentPerOrg,
            payWindowSeconds: config.payWindowSeconds, billingGraceSeconds: config.billingGraceSeconds,
          },
          prices, pricesError,
          models: models.list(),
          listings: catalog.list().map((l) => ({ slug: l.slug, name: l.name, source: l.source, tiers: l.tiers, skus: l.tiers.map((t) => skuFor(l, t)) })),
          ...hall.summary(),
        });
      }

      return json(res, 404, { error: { code: 'not_found', message: `Nothing at ${path}` } });
    } catch (error) {
      const failure = failureFor(error);
      return json(res, failure.http, { error: { code: failure.code, message: error.message } }, extraHeaders);
    }
  };

  // The REST view of a hire is the A2A task plus the convenience a shell wants.
  function hireView(hire, hireToken = null) {
    return {
      hire: {
        id: hire.id, contextId: hire.contextId, agent: hire.slug, model: hire.model, tier: hire.tier,
        state: hire.state, status: hire.statusText, retryable: hire.retryable,
        free: hire.free, freeReason: hire.freeReason ?? null,
        charge: hire.charge, payment: hire.payment,
        budget: hire.budget, spent: hire.spent, turns: hire.turns,
        artifacts: hire.artifacts.map(({ artifactId, name, text, data, mediaType, from }) => ({ artifactId, name, text, data, mediaType, from })),
        subHires: hire.subHires, plan: hire.plan ?? null,
        createdAt: hire.createdAt, updatedAt: hire.updatedAt,
      },
      ...(hireToken ? { hireToken } : {}),
    };
  }

  async function rpc(req, res, { slug, extraHeaders, callerAddress }) {
    let body;
    try {
      body = await readBody(req, config.maxRequestBytes);
    } catch (error) {
      return rpcError(res, null, A2A_ERROR.parse, error.message, 400, extraHeaders);
    }
    const id = body?.id ?? null;
    if (body?.jsonrpc !== '2.0' || typeof body?.method !== 'string') {
      return rpcError(res, id, A2A_ERROR.invalidRequest, 'A2A calls are JSON-RPC 2.0 objects with a method', 400, extraHeaders);
    }
    const entry = METHODS.get(body.method);
    if (!entry) {
      return rpcError(res, id, A2A_ERROR.methodNotFound, `${body.method} is not a method here. This hall speaks A2A 1.0 (SendMessage and the rest) and A2A 0.3 (message/send and the rest).`, 404, extraHeaders);
    }
    // The method decides the dialect, not the path: a 0.3 client that finds the 1.0 endpoint still
    // gets answered in 0.3.
    const dialect = entry.dialect;
    const params = body.params ?? {};

    try {
      switch (entry.op) {
        case 'sendMessage':
        case 'streamMessage': {
          const parsed = parseSendParams(params, { dialect });
          const stream = entry.op === 'streamMessage';
          if (parsed.taskId) {
            // Continuing a hire: a payment submission needs no token, anything else does.
            const hire = parsed.payment?.payload || parsed.payment?.status === 'payment-rejected'
              ? await hall.send({ id: parsed.taskId, text: parsed.text, data: parsed.data, payment: parsed.payment, defer: stream })
              : await hall.send({ id: parsed.taskId, text: parsed.text, data: parsed.data, tokenPresented: bearer(req) || parsed.hireToken, defer: stream });
            if (!stream) return rpcResult(res, id, taskPayload(taskView(hire, dialect, { historyLength: parsed.historyLength }), dialect), extraHeaders);
            return streamTask(res, id, hire, dialect, extraHeaders);
          }
          const wanted = slug ?? parsed.agent ?? (parsed.skill?.includes(':') ? parsed.skill.split(':')[0] : null);
          if (!wanted) {
            throw Object.assign(new Error('Name the agent to hire: post to /agents/<slug>/a2a/v1, or send metadata { "roster/agent": "<slug>" }. GET /v1/listings lists them.'), { code: 'invalid_request' });
          }
          const skill = parsed.skill?.includes(':') ? parsed.skill.split(':')[1] : parsed.skill;
          const { hire, hireToken } = await hall.hire({
            slug: wanted, text: parsed.text, data: parsed.data, model: parsed.model, skill,
            contextId: parsed.contextId, callerAddress, defer: stream,
          });
          if (!stream) {
            return rpcResult(res, id, taskPayload(taskView(hire, dialect, { includeToken: true, historyLength: parsed.historyLength }), dialect), extraHeaders);
          }
          return streamTask(res, id, hire, dialect, extraHeaders, { includeToken: true, hireToken });
        }
        case 'getTask': {
          hall.authorize(params.id, tokenFrom(req, params));
          await hall.refresh(params.id);
          return rpcResult(res, id, taskView(hall.get(params.id), dialect, { historyLength: params.historyLength ?? null }), extraHeaders);
        }
        case 'listTasks': {
          // There is deliberately no route that lists every task on the deployment. A hire token lists
          // the context that hire belongs to, and nothing else.
          const anchor = hall.authorize(params.anchorTaskId ?? params.id ?? '', tokenFrom(req, params));
          const tasks = hall.list({ contextId: params.contextId ?? anchor.contextId, state: params.status ?? null, limit: params.pageSize ?? 50 });
          return rpcResult(res, id, {
            tasks: tasks.map((hire) => taskView(hire, dialect, { historyLength: params.historyLength ?? 0 })),
            nextPageToken: '', pageSize: tasks.length, totalSize: tasks.length,
          }, extraHeaders);
        }
        case 'cancelTask': {
          const hire = await hall.cancel(params.id, tokenFrom(req, params));
          return rpcResult(res, id, taskView(hire, dialect), extraHeaders);
        }
        case 'subscribeTask': {
          const hire = hall.authorize(params.id, tokenFrom(req, params));
          if (isTerminal(hire.state)) {
            throw Object.assign(new Error(`This hire is already ${hire.state} and cannot be subscribed to`), { code: 'unsupported_operation' });
          }
          return streamTask(res, id, hire, dialect, extraHeaders);
        }
        case 'extendedCard':
          throw Object.assign(new Error('This hall publishes one card and has no extended card'), { code: 'extended_card' });
        case 'pushUnsupported':
          return rpcError(res, id, A2A_ERROR.pushNotificationNotSupported, 'This hall does not take push notification configs. Hold the stream or poll GetTask.', 400, extraHeaders);
        default:
          return rpcError(res, id, A2A_ERROR.methodNotFound, `${body.method} is not implemented`, 404, extraHeaders);
      }
    } catch (error) {
      if (error.code === 'extended_card') {
        return rpcError(res, id, A2A_ERROR.extendedAgentCardNotConfigured, error.message, 400, extraHeaders);
      }
      const failure = failureFor(error);
      return rpcError(res, id, failure.rpc, error.message, failure.http, extraHeaders, failure.code);
    }
  }

  function rpcResult(res, id, result, extraHeaders) {
    return json(res, 200, { jsonrpc: '2.0', id, result }, extraHeaders);
  }

  function rpcError(res, id, code, message, http, extraHeaders, reason = null) {
    const body = {
      jsonrpc: '2.0', id,
      error: {
        code, message,
        ...(reason ? { data: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'roster.instance' }] } : {}),
      },
    };
    // The JSON-RPC error carries the meaning; the HTTP status is there so proxies and humans agree
    // with it. 401 is the one that must be an HTTP status, because it is about the credential.
    return json(res, http === 401 ? 401 : 200, body, extraHeaders);
  }

  async function streamTask(res, id, hire, dialect, extraHeaders, { includeToken = false } = {}) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', ...extraHeaders,
    });
    const send = (result) => res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, result })}\n\n`);
    // The first event is the task itself, so a client holding only a stream still learns its id, its
    // hire token and, when payment is due, what it owes.
    send(taskPayload(taskView(hire, dialect, { includeToken }), dialect));
    if (isTerminal(hire.state) || hire.state === 'TASK_STATE_INPUT_REQUIRED') {
      return res.end();
    }
    const events = hall.subscribe(hire.id);
    let closed = false;
    res.on('close', () => { closed = true; });
    // Held until now, so nothing this caller is paying to watch happens before it is listening.
    hire.startWork?.();
    for await (const event of events) {
      if (closed) break;
      send(streamEvent(event.hire, dialect, { artifact: event.artifact ?? null }));
      if (isTerminal(event.hire.state) && !event.artifact) break;
    }
    return res.end();
  }
}

export function startServer({ env = process.env, billing, providers, store } = {}) {
  const config = loadConfig(env);
  const money = billing ?? buildBilling(config);
  const state = store ?? (config.stateFile ? new HallStore({ path: config.stateFile }) : new NullStore());
  const catalog = new Catalog({ dir: new URL('../agents/', import.meta.url).pathname, store: state, config });
  const models = new ModelRouter({ providers: providers ?? buildProviders(config), extraModels: config.extraModels });
  const hall = new Hall({ billing: money, catalog, models, config, store: state });
  const server = createServer(createApp({ hall, catalog, models, config }));
  // One sweep a second decides who has run out of time to pay and whose work has gone quiet.
  const timer = setInterval(() => { hall.tick().catch((error) => console.error('tick failed:', error.message)); }, 1000);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  return {
    server, hall, catalog, models, config,
    listen: () => new Promise((resolve) => server.listen(config.port, '127.0.0.1', resolve)),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const app = startServer();
  await app.listen();
  const available = app.models.list().filter((m) => m.available).length;
  console.log(`roster listening on http://127.0.0.1:${app.config.port} (billing: ${app.config.billing}, listings: ${app.catalog.list().length}, models available: ${available}/${app.models.list().length})`);
  if (!available) console.warn('No model is available: every hire will be refused until a provider credential is set. See DESIGN.md.');
}
