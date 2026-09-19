// Conformance check: the OFFICIAL A2A JS SDK client against this server, discovered through its card.
// Nothing here is Roster's own client code, which is the point: it proves the wire is the protocol's,
// not ours. This repo stays dependency free, so the SDK is installed outside it:
//
//   mkdir -p /tmp/a2a-interop && cd /tmp/a2a-interop && npm init -y && npm install @a2a-js/sdk
//   cp ~/roster/tools/interop-sdk.mjs . && node interop-sdk.mjs http://127.0.0.1:8810 copy-editor <model>
//
// Verified against @a2a-js/sdk 1.2.0 on 2026-09-19: all five steps below passed, including the SDK's
// own v0.3 compatibility transport against our 0.3 interface.
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { Role } from '@a2a-js/sdk';
import { randomUUID } from 'node:crypto';

const base = process.argv[2] ?? 'http://127.0.0.1:8810';
const slug = process.argv[3] ?? 'copy-editor';
const model = process.argv[4] ?? 'openrouter/stub-1';
const partText = (parts = []) => parts.map((p) => (p.content?.$case === 'text' ? p.content.value : '')).filter(Boolean).join(' ');

// The card declares an apiKey-in-header scheme for the hire token, so the client satisfies it the
// standard way: its own fetch adds the header. hireToken is filled in once the first hire hands it over.
let hireToken = null;
const fetchWithHireToken = (url, init = {}) => fetch(url, {
  ...init,
  headers: { ...(init.headers ?? {}), ...(hireToken ? { 'X-Roster-Hire': hireToken } : {}) },
});

const options = ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
  transports: [new JsonRpcTransportFactory({ fetchImpl: fetchWithHireToken, legacyCompat: { enabled: true } })],
});
const client = await new ClientFactory(options).createFromUrl(`${base}/agents/${slug}/.well-known/agent-card.json`, '');
console.log('1. built a client from the card');

const message = {
  messageId: randomUUID(),
  role: Role.ROLE_USER,
  parts: [{ content: { $case: 'text', value: 'Tighten this sentence, which is, as it happens, rather longer than it truly needs to be.' } }],
  metadata: { 'urn:instance:roster:hire:v1': { model } },
};

const result = await client.sendMessage({ message });
const task = result.task ?? result;
console.log('2. sendMessage ->', `state ${task.status?.state}`, '| artifacts:', (task.artifacts ?? []).map((a) => a.name).join(', '));
console.log('   artifact:', partText(task.artifacts?.[0]?.parts).slice(0, 90));
console.log('   usage from the task metadata:', JSON.stringify(task.metadata?.['roster/usage']));

hireToken = task.metadata?.['roster/hireToken'];
const read = await client.getTask({ id: task.id });
console.log('3. getTask with the hire token ->', `state ${read.status?.state}`, '| same task:', read.id === task.id);

// The SDK hands streamed payloads back as a tagged union, so read the tag.
const events = [];
for await (const event of client.sendMessageStream({ message: { ...message, messageId: randomUUID() } })) {
  const { $case: kind, value } = event.payload ?? {};
  if (kind === 'task') events.push(`task(state ${value.status.state})`);
  if (kind === 'statusUpdate') events.push(`status(state ${value.status.state})${value.final ? ' final' : ''}`);
  if (kind === 'artifactUpdate') events.push(`artifact(${value.artifact.name})`);
}
console.log('4. sendMessageStream ->', events.join(' -> '));

// And the same server, through the SDK's own v0.3 compatibility transport, off the 0.3 interface.
const legacy = await new ClientFactory(options).createFromAgentCard({
  name: 'Roster 0.3', description: 'the same hall over the older dialect', version: '0.1.0',
  supportedInterfaces: [{ url: `${base}/agents/${slug}/a2a/v0.3`, protocolBinding: 'JSONRPC', protocolVersion: '0.3' }],
  capabilities: { streaming: true, pushNotifications: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [],
});
const legacyTask = await legacy.sendMessage({ message: { ...message, messageId: randomUUID() } });
const lt = legacyTask.task ?? legacyTask;
console.log('5. the SDK v0.3 transport ->', `state ${lt.status?.state}`, '| artifact:', partText(lt.artifacts?.[0]?.parts).slice(0, 60));
