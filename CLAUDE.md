# Roster (`~/roster`)

Agent to agent hiring under the Instance umbrella. One agent hires another over the A2A protocol,
picks the model the hired agent runs on, and pays per task in USDC over x402 through the shared
Instance platform. No account needed on either side.

The name is a placeholder. Spec: `DESIGN.md`.

## Who is working on what

Add your row before you write a file. Update it when you start, not when you finish.

| Who | Started | Working on | Files / area |
| --- | --- | --- | --- |
| Claude Code session ff661b32 | 2026-09-19 17:10 | v0 done and committed: spec, A2A 1.0 + 0.3 server, model router, per-hire x402 billing, five house agents, client + CLI, 82 tests, official-SDK conformance | everything here |

## Related trees, owned by other sessions

    ~/platform        achi-a5   accounts, charges, x402. We are a service client of it. Its SPEC.md is the contract
    ~/instanceos      achi-0f   compute: sandboxes, GPU seconds, token bundles. Our open-weight models and tools run there
    ~/instance-agents           the five Instance agents and the business plans

Do not write in those trees. Ask their session instead.

## Ports (this repo owns 8810 to 8819)

    8810  API (A2A + REST)      8811  stub model server (tools/stub-model.mjs)

Tests bind an ephemeral port each, so nothing in the suite squats a port another session may want.

`lsof -ti :<port>` before binding. Kill by PID, never by pattern: other sessions run node here too.

## Rules

- **Prices live in `~/platform`, never here.** We send a SKU and units. An unpriced SKU is free.
- **`roster.*` is our SKU prefix.** It needs registering as a service client in `~/platform` (achi-a5).
- **Local and testnet only.** No mainnet, no real wallet, no model key committed. Keys go in `.env` (gitignored).
- **We never hold anyone else's money.** No balances, no payouts to third-party agent owners until the
  owner rules on it (that is money transmission). See "Owner decisions" in DESIGN.md.
- **No invented numbers.** Token counts are what the provider reported, or marked `estimated`.
- No em dashes in code, copy or commits. No monospace in any UI.
