# novate — clearing house for agent trade

When two companies' AI agents agree a deal, novate becomes the counterparty to both sides. It checks
the agent was allowed to make the deal, holds funds, catches likely mistakes, releases money only
when the evidence matches, nets everyone's positions and settles the difference.

Every one of those behaviours is **policy, not code**. A tenant (a platform or marketplace) publishes
versioned _programs_; each deal resolves its program against live _signals_ and keeps a snapshot of
the result, so any decision can be explained and replayed later.

## Layout

| Package            | What it does                                                                     |
| ------------------ | -------------------------------------------------------------------------------- |
| `packages/core`    | Money (bigint minor units), deal terms, mandates, principals, canonical hashing  |
| `packages/db`      | Drizzle schema + migrations (Postgres)                                           |
| `packages/ledger`  | Double-entry, append-only ledger behind a `Ledger` interface                     |
| `packages/policy`  | Programs, CEL rules, release conditions, typed actions and their limit checks    |
| `packages/signals` | Signal provider interface, registry, static + HTTP providers                     |
| `packages/netting` | Pure multilateral / bilateral / gross netting                                    |
| `packages/fx`      | Pure FX planning: buy only the net, pool opposite flows                          |
| `packages/rails`   | Settlement rail contract, Airwallex rail, mock rail                              |
| `packages/agents`  | Claude-backed risk agent and document reader                                     |
| `packages/engine`  | DBOS workflows: deal, cycle, webhooks, reconciliation, monitor, decision gateway |
| `apps/api`         | Authenticated Hono HTTP API                                                      |

## Run it

```sh
pnpm install
cp .env.example .env
pnpm db:up            # Postgres 17 on :5433
docker compose exec -T postgres psql -U novate -c "create database novate_dbos"   # first run only
pnpm db:migrate
pnpm test
pnpm demo             # the mug scenario end to end, on the in-memory rail
pnpm dev:api          # http://localhost:4000
```

Airwallex and model agents switch on when their keys are in `.env`. Without Airwallex keys only the
mock rail exists. Without a model key, cases go to rules and then to people.

## How a deal flows

```
submit > authority > signals > resolve policy > mistake checks ─┬ freeze > decision gateway
                                                                └ lock buyer funds + seller margin
       > evaluate release conditions on each new fact ─┬ blocked > decision gateway
                                                       └ satisfied > release > obligation eligible
       > cycle: net > convert the net > fund debtors > commit > pay creditors > return margin
```

### The decision gateway

Anything needing judgement becomes a case. Rules try first, then the model, then a person. Anything
over the tenant's ceiling goes straight to a person. A decider can only pick from a fixed set of
typed actions (`packages/policy/src/actions.ts`). Code validates each one against the program's
limits and records it, accepted or refused, bound to a hash of exactly what the decider was shown.
If the evidence changes, the case goes stale and reopens.

### What happens when things go wrong

| Event                          | Response                                                                    |
| ------------------------------ | --------------------------------------------------------------------------- |
| Model down or refuses          | Falls through to the next decider                                           |
| Workflow hits an unknown error | Deal parks in `exception` with funds intact and raises a case               |
| Net debtor cannot fund         | Agent risk: excluded and the rest re-net. Principal risk: house absorbs it  |
| Payment still in flight        | Keeps waiting. It is never assumed failed                                   |
| Payout fails                   | Retry if a decider says so, otherwise the money goes to the member's wallet |
| Paid transfer later fails      | Returned to the member's wallet by compensating entries                     |
| Deposit recalled by the bank   | Taken back; the member is suspended if already spent                        |
| Ledger disagrees with rail     | Settlement halts for the tenant until resumed                               |
| Cycle hits an unknown error    | Settlement halts and a person is told                                       |

## Programs

A program combines these blocks (see `packages/policy/src/schema.ts`):

| Block               | Options                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| `funding`           | `prefunded`, `partial`, `net_then_fund`; lock in `deal` or `home` currency     |
| `margin`            | `none`, `fixed`, `scored`                                                      |
| `marginUse`         | Share of a shortfall drawn from margin; forfeit on non-performance             |
| `portfolioMargin`   | Collateral per member across open positions, marked to FX, with margin calls   |
| `risk.bearer`       | `agent` (pass-through) or `principal` (house guarantees)                       |
| `checks`            | CEL rule to `freeze`, `reject` or `flag`                                       |
| `release.condition` | Tree of `all`, `any`, `not` over documents, inspection, acceptance and more    |
| `release.amount`    | `full`, `pro_rata_inspection`, `cel`                                           |
| `settlement`        | `clear` or `verify_only`; netting; rail; timing `cycle`, `immediate`, `manual` |
| `decisions`         | Decider order, tenant ceiling per currency, rule fast paths, action limits     |
| `monitor`           | What puts an agent under review                                                |
| `dealShape`         | Allowed shapes (`goods`, `service`, `payment`), SKU rules, leg limits          |
| `overrides`         | CEL over deal + signals to patch any of the above                              |

Starting templates live in `packages/policy/src/presets.ts`: trade assurance, net settlement,
verification only, real-time agent clearing, central counterparty and marketplace settlement.

## How the agents earn trust

Every model decision is later judged by how it turned out, and the operator console shows the whole
trail: what was shown, what was proposed, what code refused and what happened to the money. A program
with `decisions.autonomy` set to `earned` starts agents on a share of the tenant's ceiling, and that
share follows their record in both directions. `POST /tenants/:id/shadow-runs` replays past decisions
against a different model, instructions or limits without touching anything.

## Connecting a trading agent

Point an MCP client at `POST /mcp` with `Authorization: Bearer <api key>`. An agent can open a deal,
file evidence and documents, and read its deal and balances. What it can do depends on its key.

## Paying over x402

A buyer agent can fund a USD deal on Metal with `POST /deals/:id/x402`. The first call answers 402 with
the price, and a retry with `PAYMENT-SIGNATURE` settles it. If the agent pays from a Metal account with
a spending mandate, the chain enforces that mandate, and any refusal is recorded on the deal.

## Evaluating the agents

`pnpm eval` puts known cases through the real model and the same limit checks production uses, and
reports what it got right, what it got wrong and anything harmful. It needs `ANTHROPIC_API_KEY` and
spends money. Add `--trials=3` to check the answers are stable.

## Security model

A party cannot bind the other side: a deal submitted by a member or agent waits until the other side
submits the same terms under the same key. Platform and house keys speak for both sides.

Every route needs a bearer key that maps to a principal and a tenant. Tenants are created with the
operator key. Money can only be credited by a signed rail webhook or a `house` key. Each kind
of evidence can only be asserted by the party entitled to assert it, and `source` comes from the
credential.

## Airwallex

Set `AIRWALLEX_CLIENT_ID` and `AIRWALLEX_API_KEY` in `.env`, expose the server
(`cloudflared tunnel --url http://localhost:4000`), then run `pnpm webhook:register <public url>`,
which subscribes it and saves the signing secret to `.env`. `pnpm test` runs a read-only live check as
soon as those keys exist.

The first time the server starts it creates the operator key, a default tenant and that tenant's
platform key, and prints them once. The default tenant owns every rail with credentials, for good.
If the operator key is lost, `pnpm reset-operator-key` replaces it.

`AIRWALLEX_CUSTODY` picks the custody model:

- `pooled` (default): one account holds members' money and the ledger says whose it is. Each member
  needs `airwallex_deposit_account` and `airwallex_beneficiary` in its `railRefs`.
- `connected`: each member is a connected account (`airwallex_account`). Funds are pulled with
  Charges and paid to the member's own wallet. Airwallex has to enable Connected Accounts first.

## See it run

`pnpm demo:live` runs the whole product on real systems, narrated, on its own fresh database: Airwallex's
sandbox with webhooks through a Cloudflare tunnel, Claude deciding cases and reading documents, trading
agents over MCP, and a stablecoin payment on Metal testnet. It opens the clearing desk beside it. Add
`--step` to pause at each part while recording, and press Ctrl-C when finished.

Stop any other novate server first, because it shares the Airwallex account. The demo points Airwallex's
webhook at its own tunnel, so run `pnpm webhook:register <url>` again afterwards for your dev server.

## Operating it

The clearing desk at `GET /console` shows whether settlement is running, the cases that need a person
and recent deals. It needs a `platform` or `house` key and keeps it in memory only.

Key handling: `POST /tenants`, `POST /tenants/:id/house-key` and `POST /tenants/:id/platform-key` take
the operator key. A platform
issues member, agent, inspector, carrier and arbiter keys. Only a house key can credit funds or resume
settlement.

For local work without Airwallex, set `NOVATE_ALLOW_MOCK_RAIL=true`. The mock settles with no money
behind it, so it is off unless asked for.

Metal (USD, for agent-run firms) switches on with `METAL_RPC_URL` and `METAL_PRIVATE_KEY`. Each member needs `metal_account` for payouts and `metal_deposit_account`, the
wallet it pays in from, so deposits can be attributed.
