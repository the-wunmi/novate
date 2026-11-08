# novate — clearing house for agent trade

When two companies' AI agents agree a deal, novate becomes the counterparty to both sides. It checks
the agent was allowed to make the deal, holds funds, catches likely mistakes, releases money only
when the evidence matches, nets everyone's positions and settles the difference.

Every one of those behaviours is **policy, not code**. A tenant (a platform or marketplace) publishes
versioned *programs*; each deal resolves its program against live *signals* and keeps a snapshot of
the result, so any decision can be explained and replayed later.

## Layout

| Package | What it does |
| --- | --- |
| `packages/core` | Money (bigint minor units), deal terms, mandates, canonical hashing |
| `packages/db` | Drizzle schema + migrations (Postgres) |
| `packages/ledger` | Double-entry, append-only ledger behind a `Ledger` interface |
| `packages/policy` | Program schema, CEL rules, release conditions, policy resolver, presets |
| `packages/signals` | Signal provider interface, registry, static + HTTP providers |
| `packages/netting` | Pure multilateral / bilateral / gross netting |
| `packages/rails` | Settlement rail interface + deterministic mock rail |
| `packages/engine` | DBOS durable workflows (deal lifecycle, clearing cycle) + service API |
| `apps/api` | Hono HTTP API |

## Run it

```sh
pnpm install
pnpm db:up            # Postgres 17 on :5433
docker compose exec -T postgres psql -U novate -c "create database novate_dbos"   # first run only
pnpm db:migrate
pnpm test             # unit tests + the end-to-end mug scenario
pnpm dev:api          # http://localhost:4000
```

## How a deal flows

```
submit ─▶ authority ─▶ signals ─▶ resolve policy ─▶ checks ─┬─▶ freeze → person confirms / cancels / reprices
                                                           └─▶ lock buyer funds + seller margin (waits for deposits)
        ─▶ evaluate release conditions on each new fact ─┬─▶ blocked → person waives / holds / releases / refunds
                                                        └─▶ satisfied → release amount → obligation eligible
        ─▶ clearing cycle: net ─▶ collect from net debtors ─▶ pay net creditors ─▶ margin returned ─▶ settled
```

The deal workflow and the cycle workflow are DBOS workflows: every step is checkpointed in Postgres,
and ledger writes are recorded in the same transaction as the step, so they happen exactly once even
across crashes.

## Programs

A program combines these building blocks (see `packages/policy/src/schema.ts`):

| Block | Options |
| --- | --- |
| `funding` | `prefunded` · `partial` (bps) · `net_then_fund` |
| `margin` | `none` · `fixed` (bps) · `scored` (base + CEL adjustments, clamped) |
| `checks` | CEL rule → `freeze` · `reject` · `flag` |
| `release.condition` | tree of `all` / `any` / `not` over `documents`, `inspection`, `acceptance`, `delivery`, `no_dispute`, `elapsed`, `cel`, or custom types registered in code |
| `release.amount` | `full` · `pro_rata_inspection` · `cel` |
| `settlement` | netting mode + rail |
| `overrides` | CEL rule over deal + signals → patch any of the above |

Example override, so funding changes with an external factor:

```json
{
  "id": "volatile_fx_prefund",
  "when": "signals.fx.vol30d > 0.12",
  "set": { "funding": { "mode": "prefunded" } },
  "reason": "Settlement currency is volatile"
}
```

CEL conventions: money is `int` in minor units (`deal.amount > 1000000`); counts, ratios and signal
values are `double` (`signals.history.seller.onTimeRate < 0.9`).

Starting templates live in `packages/policy/src/presets.ts` (`tradeAssurance`, `netSettlement`).

## Extension points

- **Signals**: implement `SignalProvider` (or use `HttpSignalProvider`) and register it at launch.
  Built-ins are `history` (counterparty and agent record from the ledger) and `fx` (a static table for now).
- **Rails**: implement `SettlementRail` (`collect`, `payout`, `status`). The mock rail ships today.
- **Conditions**: `registerCondition(type, evaluator)` for release logic you can't express in CEL.
- **Ledger**: `Ledger` is shaped so a TigerBeetle implementation can replace Postgres.

## Not built yet

- LLM document extraction (documents currently arrive with structured `fields`)
- Airwallex and Metal / x402 rails
- Live FX and tracking signal providers
- Ops console (approvals, frozen deals, programs, positions)
- Tenant API keys / auth, FX conversion planning, default fund and full default waterfall
