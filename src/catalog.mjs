import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { TIERS } from './models.mjs';

// A listing is what is for hire: a name, skills, the instructions the model works from, the tiers it
// may run at and the budget one hire gets. House listings live in agents/ and are reviewed. Published
// listings arrive over the API from anyone, including an agent, and are deliberately weaker: no tools,
// cheaper tiers only, smaller budgets, and a cap per payer.
const PUBLISHED_LIMITS = {
  instructions: 8_000,
  skills: 5,
  inputTokens: 40_000,
  outputTokens: 4_000,
};

export function skuFor(listing, tier) { return `roster.hire.${listing.slug}.${tier}`; }

function requireString(value, field, { max = 400, min = 1 } = {}) {
  if (typeof value !== 'string' || value.trim().length < min) {
    throw Object.assign(new Error(`${field} is required`), { code: 'invalid_request' });
  }
  if (value.length > max) {
    throw Object.assign(new Error(`${field} must be ${max} characters or fewer`), { code: 'invalid_request' });
  }
  return value.trim();
}

function normalizeSkills(skills, field = 'skills') {
  if (!Array.isArray(skills) || skills.length === 0) {
    throw Object.assign(new Error(`${field} must list at least one skill`), { code: 'invalid_request' });
  }
  return skills.map((skill, index) => ({
    id: requireString(skill.id, `${field}[${index}].id`, { max: 80 }),
    name: requireString(skill.name, `${field}[${index}].name`, { max: 120 }),
    description: requireString(skill.description, `${field}[${index}].description`, { max: 1_000 }),
    tags: Array.isArray(skill.tags) ? skill.tags.slice(0, 12).map((t) => String(t).slice(0, 40)) : [],
    examples: Array.isArray(skill.examples) ? skill.examples.slice(0, 6).map((t) => String(t).slice(0, 400)) : [],
    inputModes: Array.isArray(skill.inputModes) ? skill.inputModes : undefined,
    outputModes: Array.isArray(skill.outputModes) ? skill.outputModes : undefined,
  }));
}

function normalizeTiers(tiers, allowed) {
  const list = Array.isArray(tiers) && tiers.length ? tiers : allowed;
  for (const tier of list) {
    if (!allowed.includes(tier)) {
      throw Object.assign(new Error(`tier ${tier} is not one of ${allowed.join(', ')} here`), { code: 'invalid_request' });
    }
  }
  return list;
}

export class Catalog {
  #listings = new Map();
  #tokens = new Map();

  constructor({ dir, store = null, config = {}, now = () => Date.now(), newId = () => randomUUID(), newToken = () => randomBytes(24).toString('base64url') }) {
    this.config = config; this.store = store; this.now = now; this.newId = newId; this.newToken = newToken;
    if (dir) this.#loadHouse(dir);
    for (const published of store?.loadAll?.().listings ?? []) {
      this.#listings.set(published.slug, published);
      if (published.ownerToken) this.#tokens.set(published.slug, published.ownerToken);
    }
  }

  #loadHouse(dir) {
    if (!existsSync(dir)) return;
    for (const slug of readdirSync(dir).sort()) {
      const file = join(dir, slug, 'agent.json');
      if (!existsSync(file)) continue;
      const definition = JSON.parse(readFileSync(file, 'utf8'));
      const instructionsFile = join(dir, slug, 'instructions.md');
      const listing = {
        slug,
        source: 'house',
        name: requireString(definition.name, `${slug}.name`, { max: 120 }),
        description: requireString(definition.description, `${slug}.description`, { max: 1_000 }),
        version: definition.version ?? '0.1.0',
        instructions: existsSync(instructionsFile) ? readFileSync(instructionsFile, 'utf8') : requireString(definition.instructions, `${slug}.instructions`, { max: 40_000 }),
        skills: normalizeSkills(definition.skills, `${slug}.skills`),
        tiers: normalizeTiers(definition.tiers, TIERS),
        defaultModel: requireString(definition.defaultModel, `${slug}.defaultModel`, { max: 200 }),
        budget: {
          inputTokens: definition.budget?.inputTokens ?? 20_000,
          outputTokens: definition.budget?.outputTokens ?? 4_000,
        },
        output: {
          kind: definition.output?.kind === 'data' ? 'data' : 'text',
          name: definition.output?.name ?? 'result',
          description: definition.output?.description ?? null,
          mediaType: definition.output?.kind === 'data' ? 'application/json' : 'text/plain',
        },
        orchestrator: definition.orchestrator === true,
        hires: Array.isArray(definition.hires) ? definition.hires : [],
        createdAt: this.now(),
      };
      this.#listings.set(slug, listing);
    }
  }

  list() { return [...this.#listings.values()]; }

  get(slug) {
    const listing = this.#listings.get(slug);
    if (!listing) throw Object.assign(new Error(`No agent is listed as "${slug}"`), { code: 'not_found' });
    return listing;
  }

  has(slug) { return this.#listings.has(slug); }

  // Anyone may list an agent. Nobody earns from it yet, and the answer says so rather than implying a
  // revenue share that does not exist. See "Who may list an agent" in DESIGN.md.
  publish(input, { publishedBy = null } = {}) {
    if (this.config.publishing === 'off') {
      throw Object.assign(new Error('This deployment does not accept published listings'), { code: 'forbidden' });
    }
    const slugBase = requireString(input.slug ?? input.name, 'slug', { max: 60 })
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    if (!slugBase) throw Object.assign(new Error('slug must contain letters or digits'), { code: 'invalid_request' });
    let slug = slugBase;
    let n = 2;
    while (this.#listings.has(slug)) slug = `${slugBase}-${n++}`;

    const mine = this.list().filter((l) => l.source === 'published' && publishedBy && l.publishedBy === publishedBy).length;
    if (publishedBy && mine >= (this.config.maxPublishedPerOrg ?? 10)) {
      throw Object.assign(new Error(`That payer has already listed ${mine} agents here`), { code: 'forbidden' });
    }

    const allowedTiers = (this.config.publishedTiers ?? ['open', 'small', 'mid']).filter((t) => TIERS.includes(t));
    const listing = {
      slug,
      source: 'published',
      name: requireString(input.name, 'name', { max: 120 }),
      description: requireString(input.description, 'description', { max: 1_000 }),
      version: typeof input.version === 'string' ? input.version.slice(0, 40) : '0.1.0',
      instructions: requireString(input.instructions, 'instructions', { max: PUBLISHED_LIMITS.instructions }),
      skills: normalizeSkills(input.skills).slice(0, PUBLISHED_LIMITS.skills),
      tiers: normalizeTiers(input.tiers, allowedTiers),
      defaultModel: requireString(input.defaultModel, 'defaultModel', { max: 200 }),
      budget: {
        inputTokens: Math.min(Number(input.budget?.inputTokens ?? 20_000) || 0, PUBLISHED_LIMITS.inputTokens),
        outputTokens: Math.min(Number(input.budget?.outputTokens ?? 2_000) || 0, PUBLISHED_LIMITS.outputTokens),
      },
      output: {
        kind: input.output?.kind === 'data' ? 'data' : 'text',
        name: (input.output?.name ?? 'result').slice(0, 80),
        description: input.output?.description ? String(input.output.description).slice(0, 400) : null,
        mediaType: input.output?.kind === 'data' ? 'application/json' : 'text/plain',
      },
      // A published listing is a prompt with our model key behind it. Tools and sub-hires would make it
      // a way to get a shell or an outbound request, so it gets neither.
      orchestrator: false,
      hires: [],
      publishedBy,
      earnsItsPublisher: false,
      createdAt: this.now(),
    };
    if (listing.budget.inputTokens < 100 || listing.budget.outputTokens < 100) {
      throw Object.assign(new Error('budget.inputTokens and budget.outputTokens must each be at least 100'), { code: 'invalid_request' });
    }
    const ownerToken = this.newToken();
    listing.ownerToken = ownerToken;
    this.#listings.set(slug, listing);
    this.#tokens.set(slug, ownerToken);
    this.#persist();
    return { listing: this.view(listing), ownerToken };
  }

  withdraw(slug, presentedToken) {
    const listing = this.get(slug);
    if (listing.source !== 'published') {
      throw Object.assign(new Error('House listings are not withdrawn over the API'), { code: 'forbidden' });
    }
    const expected = Buffer.from(this.#tokens.get(slug) ?? '');
    const given = Buffer.from(presentedToken ?? '');
    if (expected.length === 0 || expected.length !== given.length || !timingSafeEqual(expected, given)) {
      throw Object.assign(new Error('That is not the owner token for this listing'), { code: 'unauthorized' });
    }
    this.#listings.delete(slug);
    this.#tokens.delete(slug);
    this.#persist();
    return { slug, withdrawn: true };
  }

  // The owner token never leaves in a listing view, and neither do the instructions: a listing is
  // hireable without handing over the prompt that makes it work.
  view(listing) {
    const { ownerToken, instructions, ...rest } = listing;
    return { ...rest, instructionsBytes: Buffer.byteLength(instructions ?? '', 'utf8') };
  }

  #persist() {
    if (!this.store?.saveListings) return;
    this.store.saveListings(this.list().filter((l) => l.source === 'published'));
  }
}
