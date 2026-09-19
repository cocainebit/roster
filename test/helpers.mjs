import { createServer } from 'node:http';
import { loadConfig } from '../src/config.mjs';
import { Catalog } from '../src/catalog.mjs';
import { ModelRouter } from '../src/models.mjs';
import { Hall } from '../src/hall.mjs';
import { FakeBilling } from '../src/billing.mjs';
import { FakeProvider } from '../src/providers/fake.mjs';
import { createApp } from '../src/server.mjs';

export const SMALL = 'anthropic/claude-haiku-4-5-20251001';
export const MID = 'anthropic/claude-sonnet-5';
export const FRONTIER = 'anthropic/claude-opus-5';
export const AGENTS_DIR = new URL('../agents/', import.meta.url).pathname;

export function testConfig(overrides = {}) {
  return { ...loadConfig({ ROSTER_STATE_FILE: '' }), stateFile: '', ...overrides };
}

// One hall, wired to a fake payment service and a fake model provider, with a clock a test can move.
export function harness({ prices = {}, provider = new FakeProvider(), config = {}, extraModels = [] } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const billing = new FakeBilling({ prices });
  const conf = testConfig(config);
  const catalog = new Catalog({ dir: AGENTS_DIR, config: conf, now: () => clock.t });
  const models = new ModelRouter({ providers: { anthropic: provider }, extraModels });
  let n = 0;
  const hall = new Hall({
    billing, catalog, models, config: conf,
    now: () => clock.t,
    newId: () => `id${++n}`,
    newToken: () => `tok${n}`,
  });
  return {
    hall, billing, catalog, models, provider, config: conf, clock,
    advance: (seconds) => { clock.t += seconds * 1000; },
  };
}

// The same wiring behind a real HTTP server. Each one takes an ephemeral port: no fixed port to clash
// with another session, and a fresh origin so fetch cannot reuse a socket from a server we just shut.
export async function serve(options = {}) {
  const bits = harness(options);
  const config = { ...bits.config, port: 0, publicUrl: '' };
  const server = createServer(createApp({ ...bits, config }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  config.port = server.address().port;
  config.publicUrl = `http://127.0.0.1:${config.port}`;
  const base = config.publicUrl;
  return {
    ...bits, config, server, base,
    async close() {
      // fetch keeps its sockets alive, so the port stays taken unless they are dropped first.
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
    async rpc(method, params, { path = '/a2a/v1', token = null, headers = {} } = {}) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Roster-Hire': token } : {}), ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return { status: response.status, headers: response.headers, body: await response.json() };
    },
    async get(path, { token = null } = {}) {
      const response = await fetch(`${base}${path}`, { headers: token ? { 'X-Roster-Hire': token } : {} });
      return { status: response.status, body: await response.json() };
    },
    async post(path, body, { token = null } = {}) {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Roster-Hire': token } : {}) },
        body: JSON.stringify(body ?? {}),
      });
      return { status: response.status, body: await response.json() };
    },
  };
}

export const lastArtifact = (hire) => hire.artifacts.at(-1);
