import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { serve, SMALL } from './helpers.mjs';
import { FakeProvider } from '../src/providers/fake.mjs';

const run = promisify(execFile);
const cli = new URL('../src/cli.mjs', import.meta.url).pathname;

const roster = (base, args) => run('node', [cli, ...args, '--url', base], { timeout: 30_000 });

test('the CLI lists what is for hire and which models this deployment can run', async () => {
  const app = await serve();
  try {
    const listings = await roster(app.base, ['listings']);
    assert.match(listings.stdout, /copy-editor {2}Copy Editor/);
    assert.match(listings.stdout, /foreman/);
    assert.match(listings.stdout, /Published listings earn their publisher nothing yet\./);

    const models = await roster(app.base, ['models']);
    assert.match(models.stdout, /yes {2}anthropic\/claude-haiku-4-5-20251001 {2}\(small\)/);
  } finally { await app.close(); }
});

test('the CLI hires an agent and prints the artifact it was sold', async () => {
  const app = await serve({ provider: new FakeProvider({ reply: 'the tightened line' }) });
  try {
    const { stdout } = await roster(app.base, ['hire', 'copy-editor', 'Tighten this line.']);
    assert.match(stdout, /task \S+ {2}completed/);
    assert.match(stdout, /--- edited-text ---/);
    assert.match(stdout, /the tightened line/);
    assert.match(stdout, /tokens: \d+ in, \d+ out \(provider\)/);
  } finally { await app.close(); }
});

test('the CLI speaking A2A 0.3 gets the same work', async () => {
  const app = await serve({ provider: new FakeProvider({ reply: 'legacy line' }) });
  try {
    const { stdout } = await roster(app.base, ['hire', 'copy-editor', 'Tighten this line.', '--legacy']);
    assert.match(stdout, /completed/);
    assert.match(stdout, /legacy line/);
  } finally { await app.close(); }
});

test('the CLI shows what a priced hire costs and how to pay it, and runs nothing first', async () => {
  const app = await serve({ prices: { 'roster.hire.copy-editor.small': 20_000 } });
  try {
    const { stdout } = await roster(app.base, ['hire', 'copy-editor', 'Edit this.', '--model', SMALL]);
    assert.match(stdout, /This hire costs 0\.020000 USDC/);
    assert.match(stdout, /a person pays at: http.*\/pay\//);
    assert.match(stdout, /an agent pays over x402 at: http/);
    assert.match(stdout, /roster show id1 --token/);
    assert.equal(app.provider.calls.length, 0);
  } finally { await app.close(); }
});

test('the CLI streams a hire, and reading one back needs its token', async () => {
  const app = await serve({ provider: new FakeProvider({ reply: 'streamed line' }) });
  try {
    const streamed = await roster(app.base, ['hire', 'briefer', 'Brief this.', '--stream']);
    assert.match(streamed.stdout, /--- brief ---/);
    assert.match(streamed.stdout, /streamed line/);
    assert.match(streamed.stdout, /\[TASK_STATE_COMPLETED\]/);

    const token = app.hall.list()[0].token;
    const shown = await roster(app.base, ['show', app.hall.list()[0].id, '--token', token]);
    assert.match(shown.stdout, /completed/);
    await assert.rejects(() => roster(app.base, ['show', app.hall.list()[0].id, '--token', 'wrong']), /not the hire token/);
  } finally { await app.close(); }
});
