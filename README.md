# novate

**A clearing house run by AI agents on Airwallex.**

Trading agents strike deals with each other over MCP. novate checks each agent was allowed to make
the deal, holds the money, and releases it when the evidence matches. When something looks wrong, a
model decides what to do from a fixed set of actions, within limits that code enforces. Settlement
nets everyone's obligations and pays each party once, and the books are reconciled against Airwallex
and Alta (formerly Metal). People set the rules, as versioned programs.

It is for **platforms** (agentic commerce, B2B marketplaces), which run novate as tenants, and the
**businesses** that trade on them, which join as members.

## See it in two minutes

No keys and no `.env` needed. You need Node 24, pnpm and Docker.

```sh
pnpm install
pnpm db:up            # Postgres 17 on :5433
pnpm demo
```

`pnpm demo` runs the mug scenario end to end on the in-memory rail, with no model and no real money.
The ledger, workflows, netting, checks and API are the real ones. A brand buys 1,000 mugs from a
supplier and sells 600 to a retailer; inspection passes 92% and only that much is released; one
clearing cycle nets both deals so the house converts €3,880 instead of €21,880; then an agent orders
ten times its usual size, the deal freezes before any money moves, and a house person cancels it with
a second approving, bound to what they saw. The house then reconciles against the rail and signs off
the day.

It then keeps serving the console at <http://localhost:4100/console/> until Ctrl-C, over what the run
left behind: settled, open and cancelled deals, the decision trail, the netted cycle, clean books and
each member's balances. Sign in as:

| Role     | Email                     | Password                 |
| -------- | ------------------------- | ------------------------ |
| house    | `house@demo.local`        | `demo-house-password`    |
| house    | `checker@demo.local`      | `demo-checker-password`  |
| platform | `platform@demo.local`     | `demo-platform-password` |
| member   | `treasurer@homeware.demo` | `demo-member-password`   |

The checker approves what the other house user asks for, and the member account opens the Homeware
brand's portal and statement. Each run starts from fresh `novate_demo_offline` databases. Set
`NOVATE_DEMO_PORT` to use another port. These accounts are refused anywhere but a local demo or
development database, and two-step sign-in is turned off there.

## On real systems

`pnpm demo:live` runs the whole product, narrated, on its own fresh `novate_demo` database, and opens
the console beside it. It needs, in `.env`: Airwallex sandbox keys (`AIRWALLEX_CLIENT_ID`,
`AIRWALLEX_API_KEY`), `ANTHROPIC_API_KEY`, `NOVATE_SECRET_KEY`, and optionally Alta testnet
(`METAL_RPC_URL`, `METAL_PRIVATE_KEY`). It also needs `cloudflared` for Airwallex's webhooks. Add
`--step` to pause at each chapter, and `--no-open` to keep it from opening the console with macOS's
`open`. Stop any other novate server first, because they share the Airwallex account, and run
`pnpm webhook:register <url>` again afterwards for your dev server.

It proves that agents can run real financial workflows with no person on any transaction:

1. **A platform sets the rules**: a trade assurance program, with agents allowed to decide cases up to €200,000.
2. **Businesses join**: three members, each with its own Airwallex Global Account and payout details, and a trading agent connected over MCP.
3. **Money arrives**: sandbox deposits, credited only once Airwallex confirms them by signed webhook or polling.
4. **Agents strike deals**: both sides submit the same terms; authority is checked and funds and margin locked.
5. **An agent makes a mistake**: a tenfold order freezes, and Claude decides it from a fixed list of actions.
6. **Proof of delivery**: Claude reads a weak set of shipping documents and decides the held deal; a proper bill of lading then clears it.
7. **Settlement**: nets everything, converts only the shortfall, pays each party once.
8. **Reconciliation**: every balance and transaction matches Airwallex.
9. **Card funding**: a buyer pays by card through Airwallex payment acceptance, and the books still match.
10. **Stablecoin on Alta** (when configured): a buyer pays over x402, credited only after on-chain finality.
11. **Switch programs**: the same agents move to net settlement with no prefunding; one payment settles both deals.

## How it works

The **agent core** is shared by every kind of clearing. It answers: was the agent allowed, is this a
mistake, does the evidence match and does a mismatch matter, who may decide, and what the house should
do next (resize margin, replan settlement, suspend an agent). Fast paths are rules only; a model
handles the exceptions; anything past the tenant's ceiling goes to a person.

The **money layer** varies by program. A program is versioned data (funding, margin, CEL checks,
release conditions, netting, rail, timing, decision limits), snapshotted onto each deal, so behaviour
changes without code. Presets in `packages/policy/src/presets.ts` include trade assurance, net
settlement, marketplace settlement and real-time clearing, where each deal settles alone on release,
on Airwallex or on-chain on Alta. A central counterparty program sizes portfolio margin per member
across open positions, marked to FX, issues margin calls, and on a member's failure draws its margin,
then a default fund, then the house.

A deal flows: submit, check authority, resolve the program, mistake checks (freeze or lock funds),
evaluate release conditions on each new piece of evidence, release, then a clearing cycle nets,
converts the net, funds debtors, posts novation, pays creditors and returns margin.

Safety properties:

- **Models decide, code enforces.** A decider picks one of a fixed set of typed actions
  (`packages/policy/src/actions.ts`); code validates it against the program's limits before money
  moves. Limits, margin, netting and money movement are deterministic.
- **Decisions are bound to what the model saw.** Every decision is recorded with a hash of exactly
  what the decider was shown, plus model, prompt version and prompt hash. If the evidence changes, the
  case reopens. Autonomy can be earned: a model's share of the ceiling follows its judged track record.
- **Four eyes.** People sign in with accounts (keys are for machines). Manual credits, large
  write-offs, a person's decisions above the ceiling and new rail openings wait for a second person.
- **Reconciliation halts settlement.** Any difference with the rail stops settlement on it until a
  person resolves it.
- **Append-only audit, enforced by the database.** Ledger transfers, deal events, decision records and
  control events refuse UPDATE, DELETE and TRUNCATE by trigger; mutable tables keep their history.
- **Durable workflows with idempotency.** Everything with an outside effect runs in a DBOS workflow;
  rail calls are guarded against double sends by idempotency keys, and a payment with no answer is
  never assumed failed.

Trading agents connect to `/mcp` with an API key. They can open deals, file evidence and read their
balances, never withdraw money or decide a case.

## Tests

```sh
pnpm test         # offline, under a minute: mock rails, stubbed model, never reads .env
pnpm test:live    # real Airwallex sandbox, Claude and Alta from .env; spends sandbox resources
pnpm eval         # the decision agents against the real model; needs ANTHROPIC_API_KEY, spends money
pnpm typecheck && pnpm lint
```

`pnpm test` needs only the Postgres from `pnpm db:up`. `pnpm eval` runs cases with known right and
harmful answers through the same validation as production, and fails on any harmful answer or under
90% correct (`--trials=3`, `--only=<substring>`).

## Repo layout

| Path               | What it does                                                                     |
| ------------------ | -------------------------------------------------------------------------------- |
| `packages/core`    | Money in bigint minor units, deal terms, mandates, principals, canonical hashing |
| `packages/db`      | Drizzle schema, migrations, audit triggers and least-privilege grants (Postgres) |
| `packages/ledger`  | Double-entry, append-only ledger                                                 |
| `packages/policy`  | Programs, CEL rules, release conditions, typed actions and their limit checks    |
| `packages/signals` | Signal providers, resolved once per deal and snapshotted                         |
| `packages/netting` | Pure multilateral, bilateral and gross netting                                   |
| `packages/fx`      | Pure FX planning and portfolio margin sizing                                     |
| `packages/rails`   | Settlement rail contract, Airwallex, Alta (`MetalRail`) and mock rails           |
| `packages/agents`  | Claude decision agent and document reader, and the eval suite                    |
| `packages/engine`  | DBOS workflows: deals, cycles, decisions, rail events, reconciliation, monitor   |
| `apps/api`         | Authenticated Hono API, MCP server and the demo scripts                          |
| `apps/console`     | Operator console and member portal (React), served by the API at `/console`      |

`CLAUDE.md` holds the detailed design notes: conventions, every control, and what has been confirmed
about Airwallex's API.
