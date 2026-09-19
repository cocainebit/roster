import { STATE, isTerminal, EXTENSION_URI, X402_EXTENSION_URI } from './hall.mjs';

// Wire translation, and nothing else. A2A 1.0 is the canonical dialect here; the 0.3 line is still
// what most clients and every x402 extension example speak, so both are served and each request is
// answered in the dialect it arrived in. See "Standards" in DESIGN.md for the table of differences.

export const A2A_ERROR = {
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotificationNotSupported: -32003,
  unsupportedOperation: -32004,
  contentTypeNotSupported: -32005,
  invalidAgentResponse: -32006,
  extendedAgentCardNotConfigured: -32007,
  extensionSupportRequired: -32008,
  versionNotSupported: -32009,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  parse: -32700,
};

const LEGACY_STATE = {
  [STATE.submitted]: 'submitted',
  [STATE.working]: 'working',
  [STATE.inputRequired]: 'input-required',
  [STATE.completed]: 'completed',
  [STATE.failed]: 'failed',
  [STATE.canceled]: 'canceled',
  [STATE.rejected]: 'rejected',
};

// One method table for both dialects. The value is what the server implements; the dialect is how the
// answer is shaped.
export const METHODS = new Map([
  ['SendMessage', { op: 'sendMessage', dialect: 'v1' }],
  ['SendStreamingMessage', { op: 'streamMessage', dialect: 'v1', stream: true }],
  ['GetTask', { op: 'getTask', dialect: 'v1' }],
  ['ListTasks', { op: 'listTasks', dialect: 'v1' }],
  ['CancelTask', { op: 'cancelTask', dialect: 'v1' }],
  ['SubscribeToTask', { op: 'subscribeTask', dialect: 'v1', stream: true }],
  ['GetExtendedAgentCard', { op: 'extendedCard', dialect: 'v1' }],
  ['CreateTaskPushNotificationConfig', { op: 'pushUnsupported', dialect: 'v1' }],
  ['GetTaskPushNotificationConfig', { op: 'pushUnsupported', dialect: 'v1' }],
  ['ListTaskPushNotificationConfigs', { op: 'pushUnsupported', dialect: 'v1' }],
  ['DeleteTaskPushNotificationConfig', { op: 'pushUnsupported', dialect: 'v1' }],
  // A2A 0.3, still the dialect of most clients in the wild.
  ['message/send', { op: 'sendMessage', dialect: 'legacy' }],
  ['message/stream', { op: 'streamMessage', dialect: 'legacy', stream: true }],
  ['tasks/get', { op: 'getTask', dialect: 'legacy' }],
  ['tasks/cancel', { op: 'cancelTask', dialect: 'legacy' }],
  ['tasks/resubscribe', { op: 'subscribeTask', dialect: 'legacy', stream: true }],
  ['agent/getAuthenticatedExtendedCard', { op: 'extendedCard', dialect: 'legacy' }],
  ['tasks/pushNotificationConfig/set', { op: 'pushUnsupported', dialect: 'legacy' }],
  ['tasks/pushNotificationConfig/get', { op: 'pushUnsupported', dialect: 'legacy' }],
  ['tasks/pushNotificationConfig/list', { op: 'pushUnsupported', dialect: 'legacy' }],
  ['tasks/pushNotificationConfig/delete', { op: 'pushUnsupported', dialect: 'legacy' }],
]);

// ------------------------------------------------------------------- outbound

function partsFor(artifact, dialect) {
  const parts = [];
  if (artifact.text !== null && artifact.text !== undefined && artifact.text !== '') {
    parts.push(dialect === 'legacy'
      ? { kind: 'text', text: artifact.text }
      : { text: artifact.text, mediaType: artifact.mediaType ?? 'text/plain' });
  }
  if (artifact.data !== null && artifact.data !== undefined) {
    parts.push(dialect === 'legacy'
      ? { kind: 'data', data: artifact.data }
      : { data: artifact.data, mediaType: 'application/json' });
  }
  return parts;
}

export function artifactView(artifact, dialect) {
  return {
    artifactId: artifact.artifactId,
    name: artifact.name,
    ...(artifact.from ? { description: `delivered by ${artifact.from.slug} on task ${artifact.from.taskId}` } : {}),
    parts: partsFor(artifact, dialect),
    ...(artifact.from ? { metadata: { 'roster/from': artifact.from } } : {}),
  };
}

export function messageView({ text, role = 'ROLE_AGENT', hire, dialect, metadata = null, messageId }) {
  const base = {
    messageId: messageId ?? `${hire.id}:${hire.history.length}:${role}`,
    contextId: hire.contextId,
    taskId: hire.id,
    parts: text ? [dialect === 'legacy' ? { kind: 'text', text } : { text, mediaType: 'text/plain' }] : [],
    ...(metadata ? { metadata } : {}),
  };
  return dialect === 'legacy'
    ? { kind: 'message', role: role === 'ROLE_USER' ? 'user' : 'agent', ...base }
    : { role, ...base };
}

// The x402 extension keeps the payment state on the status message's metadata, and every receipt for
// the life of the task stays in the array.
function paymentMetadata(hire) {
  if (!hire.payment) return null;
  const metadata = { 'x402.payment.status': hire.payment.status };
  if (hire.payment.required) metadata['x402.payment.required'] = hire.payment.required;
  if (hire.payment.receipts?.length) metadata['x402.payment.receipts'] = hire.payment.receipts;
  if (hire.payment.error) metadata['x402.payment.error'] = hire.payment.error;
  return metadata;
}

function taskMetadata(hire, { includeToken }) {
  const metadata = {
    'roster/agent': hire.slug,
    'roster/model': hire.model,
    'roster/tier': hire.tier,
    'roster/skill': hire.skill,
    'roster/usage': { ...hire.spent },
    'roster/budget': { ...hire.budget },
    'roster/turns': hire.turns,
  };
  if (hire.free) metadata['roster/free'] = hire.freeReason ?? 'this deployment does not price this hire';
  if (hire.charge) {
    metadata['roster/charge'] = {
      sku: hire.charge.sku, status: hire.charge.status, amountMicro: hire.charge.amountMicro,
      payUrl: hire.charge.payUrl, paymentUrl: hire.charge.paymentUrl,
      ...(hire.charge.payer ? { payer: hire.charge.payer } : {}),
    };
  }
  if (hire.retryable) metadata['roster/retryable'] = true;
  if (hire.subHires?.length) metadata['roster/subHires'] = hire.subHires;
  if (hire.parentId) metadata['roster/parent'] = hire.parentId;
  if (hire.plan) metadata['roster/plan'] = hire.plan;
  // Handed back once, when the hire is created: reading, continuing or cancelling needs it, paying
  // does not.
  if (includeToken) metadata['roster/hireToken'] = hire.token;
  return metadata;
}

function statusFor(hire, dialect) {
  const paymentMeta = paymentMetadata(hire);
  const message = hire.statusText || paymentMeta
    ? messageView({ text: hire.statusText ?? '', hire, dialect, metadata: paymentMeta, messageId: `${hire.id}:status:${hire.updatedAt}` })
    : undefined;
  return {
    state: dialect === 'legacy' ? LEGACY_STATE[hire.state] : hire.state,
    ...(message ? { message } : {}),
    timestamp: new Date(hire.updatedAt).toISOString(),
  };
}

export function taskView(hire, dialect, { includeToken = false, historyLength = null } = {}) {
  const history = hire.history.map((turn, index) => messageView({
    text: turn.data && !turn.text ? JSON.stringify(turn.data) : turn.text,
    role: turn.role, hire, dialect, messageId: `${hire.id}:${index}`,
  }));
  const trimmed = historyLength === null || historyLength === undefined
    ? history
    : history.slice(Math.max(0, history.length - Math.max(0, historyLength)));
  return {
    ...(dialect === 'legacy' ? { kind: 'task' } : {}),
    id: hire.id,
    contextId: hire.contextId,
    status: statusFor(hire, dialect),
    artifacts: hire.artifacts.map((artifact) => artifactView(artifact, dialect)),
    history: trimmed,
    metadata: taskMetadata(hire, { includeToken }),
  };
}

// A2A 1.0 wraps a streamed payload in a oneof; 0.3 sends the object itself, tagged with `kind`.
export function streamEvent(hire, dialect, { artifact = null } = {}) {
  if (artifact) {
    const event = {
      taskId: hire.id, contextId: hire.contextId,
      artifact: artifactView(artifact, dialect),
      append: false, lastChunk: true,
    };
    return dialect === 'legacy' ? { kind: 'artifact-update', ...event } : { artifactUpdate: event };
  }
  const event = {
    taskId: hire.id, contextId: hire.contextId,
    status: statusFor(hire, dialect),
    ...(isTerminal(hire.state) ? { final: true } : {}),
  };
  return dialect === 'legacy' ? { kind: 'status-update', ...event } : { statusUpdate: event };
}

export function taskPayload(task, dialect) {
  return dialect === 'legacy' ? task : { task };
}

// -------------------------------------------------------------------- inbound

function normalizeParts(parts = []) {
  const out = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') continue;
    // 0.3 tagged parts and 1.0 untagged ones both reduce to the same two things we can act on.
    if (typeof part.text === 'string') out.push({ text: part.text });
    else if (part.data !== undefined && part.data !== null) out.push({ data: part.data });
    else if (part.file) out.push({ text: '', unsupported: 'file' });
  }
  return out;
}

export function parseSendParams(params, { dialect }) {
  const message = params?.message;
  if (!message || typeof message !== 'object') {
    throw Object.assign(new Error('params.message is required'), { code: 'invalid_request' });
  }
  const parts = normalizeParts(message.parts);
  if (parts.some((p) => p.unsupported === 'file')) {
    throw Object.assign(new Error('This hall takes text and data parts. File parts are not supported yet.'), { code: 'content_type_not_supported' });
  }
  const metadata = { ...(params?.metadata ?? {}), ...(message.metadata ?? {}) };
  const ours = metadata[EXTENSION_URI] ?? {};
  const pick = (key) => ours[key] ?? metadata[`roster/${key}`] ?? null;
  const text = parts.filter((p) => typeof p.text === 'string' && p.text).map((p) => p.text).join('\n\n');
  const data = parts.find((p) => p.data !== undefined)?.data ?? null;
  const paymentStatus = metadata['x402.payment.status'] ?? null;
  return {
    dialect,
    text, data,
    agent: pick('agent'),
    model: pick('model'),
    skill: pick('skill'),
    taskId: message.taskId ?? null,
    contextId: message.contextId ?? null,
    hireToken: metadata['roster/hireToken'] ?? ours.hireToken ?? null,
    returnImmediately: params?.configuration?.returnImmediately === true,
    historyLength: params?.configuration?.historyLength ?? null,
    payment: paymentStatus || metadata['x402.payment.payload']
      ? { status: paymentStatus, payload: metadata['x402.payment.payload'] ?? null }
      : null,
  };
}

// ---------------------------------------------------------------------- cards

function interfacesFor(base) {
  return [
    { url: `${base}/a2a/v1`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
    { url: `${base}/a2a/v0.3`, protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
  ];
}

function capabilities() {
  return {
    streaming: true,
    // Not accepted rather than accepted and delivered badly: a webhook we would not retry properly is
    // worse than no webhook. A buyer polls GetTask or holds the stream.
    pushNotifications: false,
    extendedAgentCard: false,
    extensions: [
      {
        uri: X402_EXTENSION_URI,
        description: 'Hires are quoted and paid over x402. The task goes to input-required carrying x402.payment.required; send the signed x402.payment.payload on the same taskId.',
        required: false,
      },
      {
        uri: EXTENSION_URI,
        description: 'Choose the model a hire runs on, and the skill it is hired for: metadata { model, skill, agent }.',
        required: false,
      },
    ],
  };
}

// Hiring and paying need no credential at all: that is the point of the hall. The hire token, handed
// back once when a task is created, is what reading, continuing or cancelling that task needs, so it is
// declared as a scheme rather than left for a client to discover in prose. There is no card-level
// requirement, because requiring it would say a stranger cannot hire, which is false.
function securitySchemes() {
  return {
    hireToken: {
      apiKeySecurityScheme: {
        description: 'The hire token from roster/hireToken on the task, sent on a later GetTask, SendMessage, CancelTask or ListTasks for that task. Not needed to hire, and not needed to pay. A client that cannot set a header per call can instead give its whole client a fetch that adds it, or send it as metadata { "roster/hireToken": "..." } on a SendMessage, which is the only one of these requests the protocol gives a metadata field.',
        location: 'header',
        name: 'X-Roster-Hire',
      },
    },
  };
}

// One card serves both dialects: 1.0 clients read supportedInterfaces, 0.3 clients read url and
// preferredTransport, and the spec says each should ignore what it does not recognise.
function cardBase({ name, description, version, base, skills, inputModes, outputModes, publicUrl }) {
  return {
    protocolVersion: '1.0',
    name, description, version,
    supportedInterfaces: interfacesFor(base),
    capabilities: capabilities(),
    securitySchemes: securitySchemes(),
    securityRequirements: [],
    defaultInputModes: inputModes,
    defaultOutputModes: outputModes,
    skills,
    provider: { organization: 'Instance', url: publicUrl },
    // Legacy fields, for 0.3 clients reading this same document.
    url: `${base}/a2a/v0.3`,
    preferredTransport: 'JSONRPC',
  };
}

export function listingCard(listing, { publicUrl, models }) {
  const base = `${publicUrl}/agents/${listing.slug}`;
  const hireable = models.list().filter((m) => listing.tiers.includes(m.tier));
  const available = hireable.filter((m) => m.available);
  return {
    ...cardBase({
      name: listing.name,
      description: listing.description,
      version: listing.version,
      base, publicUrl,
      inputModes: ['text/plain', 'application/json'],
      outputModes: listing.output.kind === 'data' ? ['application/json'] : ['text/plain'],
      skills: listing.skills.map((skill) => ({
        id: skill.id, name: skill.name, description: skill.description,
        tags: [...skill.tags, `tier:${listing.tiers.join('|')}`],
        examples: skill.examples,
        ...(skill.inputModes ? { inputModes: skill.inputModes } : {}),
        ...(skill.outputModes ? { outputModes: skill.outputModes } : {}),
      })),
    }),
    // What a buyer needs to decide, in the one document it fetches: which models this deployment can
    // really run it on, what one hire is allowed to spend, and whether the publisher earns anything.
    metadata: {
      'roster/listing': {
        slug: listing.slug,
        source: listing.source,
        tiers: listing.tiers,
        defaultModel: listing.defaultModel,
        budget: listing.budget,
        output: listing.output,
        orchestrator: listing.orchestrator,
        skuPattern: `roster.hire.${listing.slug}.<tier>`,
        earnsItsPublisher: listing.source === 'published' ? false : null,
      },
      'roster/models': available.map((m) => ({ key: m.key, tier: m.tier })),
      'roster/modelsUnavailable': hireable.filter((m) => !m.available).map((m) => ({ key: m.key, tier: m.tier, reason: m.unavailableReason })),
    },
  };
}

// The hall itself is an agent: its skills are the agents you can hire through it, named
// <slug>:<skill>, and a message picks one with metadata { agent, skill }.
export function hallCard({ listings, publicUrl, models, version = '0.1.0' }) {
  const skills = listings.flatMap((listing) => listing.skills.map((skill) => ({
    id: `${listing.slug}:${skill.id}`,
    name: `${listing.name}: ${skill.name}`,
    description: skill.description,
    tags: [listing.slug, ...skill.tags],
    examples: skill.examples,
  })));
  return {
    ...cardBase({
      name: 'Roster',
      description: 'A hall of agents for hire. Hire one over A2A, pick the model it runs on, pay per hire in USDC over x402, with no account on either side.',
      version,
      base: publicUrl, publicUrl,
      inputModes: ['text/plain', 'application/json'],
      outputModes: ['text/plain', 'application/json'],
      skills,
    }),
    metadata: {
      'roster/listings': listings.map((l) => ({ slug: l.slug, name: l.name, card: `${publicUrl}/agents/${l.slug}/.well-known/agent-card.json`, tiers: l.tiers, source: l.source })),
      'roster/models': models.list(),
    },
  };
}
