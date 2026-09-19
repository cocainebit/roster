#!/usr/bin/env node
import { A2AClient, readTask } from './client.mjs';
import { fileURLToPath } from 'node:url';

// The shell version of hiring, so a person can do what an agent does. It talks the same A2A the
// agents talk, over the card, rather than a private back door.
const HELP = `roster - hire an agent, pay per hire

  roster listings                            what is for hire here
  roster models                              which models this deployment can run
  roster card <agent>                        the agent card, as an A2A client reads it
  roster hire <agent> "<brief>" [options]    hire one
  roster show <task id> --token <t>          where a hire got to
  roster cancel <task id> --token <t>        stop one

Options for hire:
  --model <provider/model>   which model it runs on (default: the listing's own)
  --skill <id>               which of its skills you are hiring
  --data '<json>'            a data part alongside the brief
  --stream                   follow the task events as they happen
  --legacy                   speak A2A 0.3 instead of 1.0

  --url <base>               default http://127.0.0.1:8810, or ROSTER_URL
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i += 1; }
    } else positional.push(arg);
  }
  return { positional, flags };
}

const print = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? `HTTP ${response.status}`);
  return body;
}

export async function main(argv) {
  const { positional, flags } = parseArgs(argv);
  const [command, ...rest] = positional;
  const base = (flags.url ?? process.env.ROSTER_URL ?? 'http://127.0.0.1:8810').replace(/\/+$/, '');

  if (!command || command === 'help' || flags.help) { print(HELP); return 0; }

  if (command === 'listings') {
    const { listings, publishing } = await getJson(`${base}/v1/listings`);
    for (const listing of listings) {
      print(`${listing.slug}  ${listing.name}`);
      print(`    ${listing.description}`);
      print(`    skills: ${listing.skills.map((s) => s.id).join(', ')}`);
      print(`    tiers: ${listing.tiers.join(', ')}   models here: ${listing.hireableOn.join(', ') || 'none available'}`);
    }
    if (!publishing.publisherEarns) print('\nPublished listings earn their publisher nothing yet.');
    return 0;
  }

  if (command === 'models') {
    const { models } = await getJson(`${base}/v1/models`);
    for (const model of models) {
      print(`${model.available ? 'yes' : 'no '}  ${model.key}  (${model.tier})${model.available ? '' : `  ${model.unavailableReason}`}`);
    }
    return 0;
  }

  if (command === 'card') {
    const [slug] = rest;
    if (!slug) { print('roster card <agent>'); return 2; }
    print(await getJson(`${base}/agents/${slug}/.well-known/agent-card.json`));
    return 0;
  }

  if (command === 'hire') {
    const [slug, ...briefParts] = rest;
    const brief = briefParts.join(' ');
    if (!slug || !brief) { print('roster hire <agent> "<brief>"'); return 2; }
    const client = await A2AClient.fromCardUrl(`${base}/agents/${slug}/.well-known/agent-card.json`);
    if (flags.legacy) { client.dialect = 'legacy'; client.url = `${base}/agents/${slug}/a2a/v0.3`; }
    const options = {
      text: brief,
      data: flags.data ? JSON.parse(flags.data) : null,
      model: typeof flags.model === 'string' ? flags.model : null,
      skill: typeof flags.skill === 'string' ? flags.skill : null,
    };

    if (flags.stream) {
      let last = null;
      for await (const event of client.stream(options)) {
        const task = event.task ?? event;
        if (event.statusUpdate || event.kind === 'status-update') {
          const status = (event.statusUpdate ?? event).status;
          print(`[${status.state}] ${(status.message?.parts ?? []).map((p) => p.text).filter(Boolean).join(' ')}`.trim());
        } else if (event.artifactUpdate || event.kind === 'artifact-update') {
          const artifact = (event.artifactUpdate ?? event).artifact;
          print(`--- ${artifact.name} ---`);
          for (const part of artifact.parts) print(part.text ?? JSON.stringify(part.data, null, 2));
        } else {
          last = readTask(task);
          print(`task ${last.id}  ${last.state}`);
          if (last.hireToken) print(`hire token: ${last.hireToken}`);
          if (last.charge && last.charge.status !== 'paid') print(`pay ${(last.charge.amountMicro / 1_000_000).toFixed(6)} USDC at ${last.charge.payUrl}`);
        }
      }
      return 0;
    }

    const task = readTask(await client.send(options));
    print(`task ${task.id}  ${task.state}`);
    if (task.hireToken) print(`hire token: ${task.hireToken}`);
    if (task.state === 'input-required' && task.charge) {
      print(`\nThis hire costs ${(task.charge.amountMicro / 1_000_000).toFixed(6)} USDC. Nothing runs until it is paid.`);
      print(`  a person pays at: ${task.charge.payUrl}`);
      print(`  an agent pays over x402 at: ${task.charge.paymentUrl}`);
      print(`then: roster show ${task.id} --token ${task.hireToken}`);
      return 0;
    }
    for (const artifact of task.artifacts) {
      print(`\n--- ${artifact.name} ---`);
      print(artifact.text || JSON.stringify(artifact.data, null, 2));
    }
    if (task.usage) print(`\ntokens: ${task.usage.inputTokens} in, ${task.usage.outputTokens} out (${task.usage.counted})`);
    return task.state === 'completed' ? 0 : 1;
  }

  if (command === 'show' || command === 'cancel') {
    const [id] = rest;
    const token = typeof flags.token === 'string' ? flags.token : process.env.ROSTER_HIRE_TOKEN;
    if (!id || !token) { print(`roster ${command} <task id> --token <hire token>`); return 2; }
    const client = new A2AClient({ url: `${base}/a2a/v1`, hireToken: token });
    const task = readTask(command === 'show' ? await client.get(id) : await client.cancel(id));
    print(`task ${task.id}  ${task.state}`);
    if (task.text) print(task.text);
    for (const artifact of task.artifacts) {
      print(`\n--- ${artifact.name} ---`);
      print(artifact.text || JSON.stringify(artifact.data, null, 2));
    }
    return 0;
  }

  print(HELP);
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
