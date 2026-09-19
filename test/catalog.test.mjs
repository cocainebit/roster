import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog, skuFor } from '../src/catalog.mjs';
import { ModelRouter, parseModelKey, TIERS } from '../src/models.mjs';
import { FakeProvider } from '../src/providers/fake.mjs';
import { testConfig, AGENTS_DIR, SMALL } from './helpers.mjs';

const catalogue = () => new Catalog({ dir: AGENTS_DIR, config: testConfig() });

test('the house listings load with their instructions, skills and budgets', () => {
  const catalog = catalogue();
  assert.deepEqual(catalog.list().map((l) => l.slug).sort(), ['briefer', 'copy-editor', 'extractor', 'foreman', 'reviewer']);
  const editor = catalog.get('copy-editor');
  assert.equal(editor.source, 'house');
  assert.ok(editor.instructions.includes('You are a copy editor'));
  assert.ok(editor.skills.length >= 2);
  assert.equal(editor.output.kind, 'text');
  assert.equal(catalog.get('extractor').output.kind, 'data');
  assert.equal(catalog.get('foreman').orchestrator, true);
  assert.equal(catalog.get('copy-editor').orchestrator, false);
  assert.equal(skuFor(editor, 'mid'), 'roster.hire.copy-editor.mid');
});

test('a listing never hands out the prompt that makes it work', () => {
  const catalog = catalogue();
  const view = catalog.view(catalog.get('reviewer'));
  assert.equal(view.instructions, undefined);
  assert.ok(view.instructionsBytes > 100);
  assert.equal(view.ownerToken, undefined);
});

test('a published listing is capped: tiers, budget, instruction size and skill count', () => {
  const catalog = new Catalog({ dir: AGENTS_DIR, config: testConfig({ publishedTiers: ['open', 'small'] }) });
  const { listing, ownerToken } = catalog.publish({
    name: 'Tone Checker', description: 'Says whether a message reads as rude.',
    instructions: 'Judge tone. Answer in one line.', defaultModel: SMALL, tiers: ['small'],
    budget: { inputTokens: 999_999, outputTokens: 999_999 },
    skills: Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, name: `Skill ${i}`, description: 'Does a thing.' })),
  }, { publishedBy: '10.0.0.1' });
  assert.ok(ownerToken);
  assert.equal(listing.slug, 'tone-checker');
  assert.equal(listing.budget.inputTokens, 40_000, 'a published budget is capped');
  assert.equal(listing.budget.outputTokens, 4_000);
  assert.equal(listing.skills.length, 5, 'a published listing gets at most five skills');
  assert.equal(listing.orchestrator, false);
  assert.equal(listing.earnsItsPublisher, false);

  assert.throws(() => catalog.publish({
    name: 'Rich', description: 'Wants the best.', instructions: 'Be expensive.',
    defaultModel: 'anthropic/claude-opus-5', tiers: ['frontier'],
    skills: [{ id: 'a', name: 'A', description: 'Does a thing.' }],
  }), (error) => error.code === 'invalid_request');

  assert.throws(() => catalog.publish({
    name: 'Long', description: 'Too much.', instructions: 'x'.repeat(9_000),
    defaultModel: SMALL, tiers: ['small'], skills: [{ id: 'a', name: 'A', description: 'Does a thing.' }],
  }), (error) => error.code === 'invalid_request');
});

test('a slug that is taken gets a suffix rather than overwriting a listing', () => {
  const catalog = catalogue();
  const first = catalog.publish({
    name: 'Copy Editor', description: 'Another one.', instructions: 'Edit.', defaultModel: SMALL,
    tiers: ['small'], skills: [{ id: 'edit', name: 'Edit', description: 'Edits text.' }],
  });
  assert.equal(first.listing.slug, 'copy-editor-2');
  assert.equal(catalog.get('copy-editor').source, 'house');
});

test('one payer cannot fill the hall with listings', () => {
  const catalog = new Catalog({ dir: AGENTS_DIR, config: testConfig({ maxPublishedPerOrg: 2 }) });
  const one = { description: 'A thing.', instructions: 'Do the thing.', defaultModel: SMALL, tiers: ['small'], skills: [{ id: 'a', name: 'A', description: 'Does a thing.' }] };
  catalog.publish({ ...one, name: 'One' }, { publishedBy: '10.0.0.5' });
  catalog.publish({ ...one, name: 'Two' }, { publishedBy: '10.0.0.5' });
  assert.throws(() => catalog.publish({ ...one, name: 'Three' }, { publishedBy: '10.0.0.5' }), (error) => error.code === 'forbidden');
  // A different payer is unaffected.
  assert.ok(catalog.publish({ ...one, name: 'Three' }, { publishedBy: '10.0.0.6' }).listing.slug);
});

test('publishing can be turned off entirely', () => {
  const catalog = new Catalog({ dir: AGENTS_DIR, config: testConfig({ publishing: 'off' }) });
  assert.throws(() => catalog.publish({ name: 'X', description: 'x', instructions: 'x', defaultModel: SMALL, tiers: ['small'], skills: [{ id: 'a', name: 'A', description: 'a thing' }] }), (error) => error.code === 'forbidden');
});

test('withdrawing needs the owner token, and house listings are never withdrawn over the API', () => {
  const catalog = catalogue();
  const { listing, ownerToken } = catalog.publish({
    name: 'Temp', description: 'Short lived.', instructions: 'Do a thing.', defaultModel: SMALL,
    tiers: ['small'], skills: [{ id: 'a', name: 'A', description: 'Does a thing.' }],
  });
  assert.throws(() => catalog.withdraw(listing.slug, 'wrong'), (error) => error.code === 'unauthorized');
  assert.throws(() => catalog.withdraw('copy-editor', ownerToken), (error) => error.code === 'forbidden');
  assert.deepEqual(catalog.withdraw(listing.slug, ownerToken), { slug: listing.slug, withdrawn: true });
  assert.throws(() => catalog.get(listing.slug), (error) => error.code === 'not_found');
});

test('published listings survive a restart and keep their owner token', () => {
  const state = { hires: [], listings: [] };
  const store = { loadAll: () => state, saveHires: () => {}, saveListings: (listings) => { state.listings = listings; } };
  const first = new Catalog({ dir: AGENTS_DIR, config: testConfig(), store });
  const { listing, ownerToken } = first.publish({
    name: 'Persistent', description: 'Stays.', instructions: 'Do a thing.', defaultModel: SMALL,
    tiers: ['small'], skills: [{ id: 'a', name: 'A', description: 'Does a thing.' }],
  });
  const second = new Catalog({ dir: AGENTS_DIR, config: testConfig(), store });
  assert.equal(second.get(listing.slug).name, 'Persistent');
  assert.deepEqual(second.withdraw(listing.slug, ownerToken), { slug: listing.slug, withdrawn: true });
});

test('a model key needs a provider and a tier, and a bad tier is refused at boot', () => {
  assert.deepEqual(parseModelKey('openrouter/meta-llama/llama-3.3-70b'), { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b' });
  assert.throws(() => parseModelKey('nostructure'), (error) => error.code === 'invalid_request');
  assert.throws(() => new ModelRouter({ extraModels: ['openai/gpt-x=enormous'] }), /tier one of/);
  assert.deepEqual(TIERS, ['open', 'small', 'mid', 'frontier']);
});

test('the router lists a declared model as unavailable with the reason, and refuses to run it', async () => {
  const router = new ModelRouter({ providers: { anthropic: new FakeProvider() }, extraModels: ['openrouter/openai/gpt-5=frontier'] });
  const listed = router.list();
  const openrouter = listed.find((m) => m.key === 'openrouter/openai/gpt-5');
  assert.equal(openrouter.available, false);
  assert.match(openrouter.unavailableReason, /no credential for openrouter/);
  assert.equal(openrouter.tier, 'frontier');
  assert.equal(listed.find((m) => m.key === SMALL).available, true);
  await assert.rejects(() => router.run({ key: 'openrouter/openai/gpt-5', messages: [] }), (error) => error.code === 'model_unavailable');
  await assert.rejects(() => router.run({ key: 'anthropic/made-up', messages: [] }), (error) => error.code === 'invalid_request');
});

test('the router passes the system prompt and ceiling through to the provider', async () => {
  const provider = new FakeProvider();
  const router = new ModelRouter({ providers: { anthropic: provider } });
  await router.run({ key: SMALL, system: 'be brief', messages: [{ role: 'user', content: 'hello' }], maxOutputTokens: 42 });
  assert.equal(provider.calls[0].model, 'claude-haiku-4-5-20251001', 'the provider gets the model, not the key');
  assert.equal(provider.calls[0].system, 'be brief');
  assert.equal(provider.calls[0].maxOutputTokens, 42);
});
