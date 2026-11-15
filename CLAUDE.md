# novate

A clearing house run by agents on Airwallex. Agents track every balance, move the money and manage
the risk, with no human in the loop on individual transactions. People set the rules.

Brief it answers: "Build the future of banking on Airwallex's APIs. Come with an idea and create a
groundbreaking product." We ship agents that run real financial workflows, not a demo. There is no
deadline, so build it well.

Buyer: platforms (agentic commerce, B2B marketplaces) as tenants, businesses as members.
Original pitch, a starting point and not the spec: <https://claude.ai/artifact/BSscrkUVJ6ugcq8QzXbTNo>

## End state to design toward

The mug scenario runs unattended on Airwallex sandbox. Switching programs then makes the same agents
run net settlement.

## Principles

- The agent layer is the core and is shared by every clearing type. It answers: was the agent
  allowed, is this a mistake, does the evidence match and does a mismatch matter, who or what may
  decide, and what should the house do next (resize margin, replan settlement, suspend an agent).
- The money layer varies by program. It must eventually support trade assurance, net settlement,
  verification-only, real-time agent clearing and a full central counterparty. Go deep on the agent
  core and prove it through one money type (trade assurance with netting) end to end first.
- Never hardcode the mug flow. Behaviour belongs in versioned programs, snapshotted per deal.
- Models decide; code enforces. A model picks from a fixed set of typed actions. Code validates each
  one against the program's limits before money moves. Limits, margin, netting and money movement
  stay deterministic.
- Frozen or held deals go to a risk agent instead of a person. Each decision is recorded and bound
  to exactly what the agent saw. People hear only about what falls outside limits. Every program has
  a hard ceiling that the tenant sets.
- Fast paths are rules only. The model handles exceptions.

## Code conventions

- Arguments go trusted first, input last: `decideCase(caseId, principal, input)`, and `(db, ...)` for
  anything running in a transaction.
- Pass a loaded object along rather than an id that forces another lookup. Re-read only what can
  really change between steps.
- Service functions own validation: each takes `z.input<typeof X>` and calls `parse(X, input)`.
- A cycle's fixed context travels as one `CycleRun`. A workflow step never reloads it.
- Network calls inside workflows go through `networkStep`. Catch with `isWorkflowControl` so DBOS
  cancellation always passes through.

## Working rules

- Airwallex credentials go in `.env` only. Never ask the user to paste them into chat.
- Never commit or merge unless asked for that commit. The user reviews and stages files, then asks.
- Do not end work with a commit question or a list of optional leftovers. Finish what can be finished.
- Money is bigint minor units everywhere inside novate. Convert only at the rail boundary.
- Ledger transfers and deal events are append-only. Correct with reversing entries.
- Anything that moves money needs an idempotency key and a test of its failure path.

## Run it

```sh
pnpm install
cp .env.example .env
pnpm db:up            # Postgres 17 on :5433
docker compose exec -T postgres psql -U novate -c "create database novate_dbos"   # first run only
pnpm db:migrate
pnpm test             # needs Postgres; each package recreates its own novate_test_* databases
pnpm typecheck
pnpm lint
pnpm dev:api          # http://localhost:4000
```

Offline tests never touch the dev databases (`freshTestDatabases`), because a server does work for every
tenant in its database and tests create thousands. `NOVATE_LIVE=1` opts out, for the live tests that drive
a running server.

## Architecture

TypeScript monorepo (pnpm, turbo), Postgres, DBOS durable workflows, Drizzle, Hono, CEL for rules.

- `packages/core`: money, deal terms, mandates, principals, canonical hashing, domain errors.
- `packages/db`: Drizzle schema and migrations.
- `packages/ledger`: double-entry, append-only ledger behind a `Ledger` interface.
- `packages/policy`: programs, CEL rules, release conditions, typed actions and `validateAction`.
- `packages/signals`: signal providers resolved once per deal and snapshotted.
- `packages/netting`: pure multilateral, bilateral and gross netting.
- `packages/fx`: pure FX planning and portfolio margin sizing.
- `packages/rails`: `SettlementRail` contract, `AirwallexRail`, `MockRail`.
- `packages/agents`: `ClaudeDecisionAgent`, `ClaudeDocumentReader`. Default model `claude-opus-5-5`.
- `packages/engine`: `deal-workflow.ts`, `cycle-workflow.ts`, `decisions.ts` (the gateway),
  `rail-events.ts`, `reconciliation.ts`, `monitor.ts`, `portfolio-margin.ts`, `scheduler.ts`,
  `service.ts`.
- `apps/api`: authenticated Hono API.

Everything that needs judgement goes through `resolveCase` in `decisions.ts`, and its one path to a
decision is `applyProposal`. Never add a second way to change a deal.

Cycles run one per settlement group (rail, netting, timing). Order: claim, net, convert, fund, then
`commit` posts novation and reads payouts straight from the ledger, then pay and close.

Database steps are exactly-once because DBOS records them in the same transaction. Rail calls are
at-least-once and rely on idempotency keys. A payment with no answer is never assumed failed.

Reconciliation assumes one rail account per tenant, recorded in `railOwners`. Rails with no owner
are not reconciled on a schedule. What an account already holds when a rail is connected is recorded
once at boot (`recordRailOpening`, a `recon_runs` row with status `opening`) and left out of later
comparisons; everything after that must add up.

The first boot (`instance-setup.ts`) creates the operator key, a default tenant and its platform key,
stores only hashes and prints the keys once. That tenant owns every rail the server runs and never
changes, so adding tenants never moves the money. It is all one row in `instance_setup`, and nothing
about it comes from the environment. Tests pass `isOperator` to `createApp`, so no known key is written to a shared database.

House keys can credit funds, so only the operator key can issue them. In a case, a party to the deal
may only take actions against its own interest (`mayDecideCase`). A deal from a party waits for the
other side to submit the same terms. Rail identifiers are set only with a house key.

Settlement accounts belong to a cycle (`Accounts.cycleSettlement`), and a cycle's positions are read
from them. Obligations settle together only within a group of rail, netting, timing and program.

A central counterparty program sets `portfolioMargin`. `portfolio-margin.ts` sizes each member's
collateral across its open positions, in its home currency, from net payables, a volatility stress
and any unrealised loss since the rate at which the position was first marked. The wallet tops it up
automatically. A shortfall becomes a margin call; past its deadline a decider extends it or declares
a default, which makes the member `close_only`: no new positions, existing ones still settle. A
member's failed funding then draws its deal margin, its portfolio margin (converted if need be), the
default fund and last the house. FX is the only market being marked, because goods have no feed.

Airwallex deposits are also polled, so a missed webhook cannot lose one. A deposit no member can be matched to is posted to `houseSuspense`, so reconciliation stays clean,
and an operator assigns it. This is the fallback if Airwallex cannot give each member a Global Account.

A withdrawal is a one-payment cycle (`runWithdrawal`), so it shares a payout's reservation, in-doubt
handling and fallback to the wallet. Money only leaves to the destination the house has on record.

Anything the outside world should hear about is a `Notification` in `notifications.ts`, sent with
`notify`. Each one is its own durable workflow that retries for hours, so a restart cannot lose it
and a slow receiver holds up nothing. `Notifier` is only the transport. The server posts to
`NOVATE_ALERT_WEBHOOK_URL`, signed with `NOVATE_ALERT_WEBHOOK_SECRET`, or logs if that is not set.

JSON columns take bigints directly: `jsonb` in `packages/db/src/schema.ts` writes them as strings.
Do not convert before inserting. API responses do the same through `toJson`.

Autonomy is earned, not assumed. The monitor records how each model decision turned out
(`judgeDecision`, `decision_outcomes`). With `decisions.autonomy.mode: earned`, a model may decide up
to a share of the tenant's ceiling that rises and falls with the lower confidence bound of its recent
record per case kind. The ceiling itself never moves, and anything past the earned share goes to a
person. `/decisions/:caseId` shows the full trail of a decision, and `shadow.ts` replays past decisions
against a candidate model, instructions or limits without changing anything.

A scheduled cycle with `treasury.mode: agent` is checked first: if everyone can fund it and rates are
calm it just runs, otherwise a model chooses between plans code built. Holds are capped. Reserves now
move both ways, and an automated decrease can't go below what the numbers support.

Trading agents can connect over MCP at `/mcp` with their API key. `apps/api/src/agent-tools.ts` is
the whole surface, and every tool runs as the calling key under the same permissions as REST. It has
no way to withdraw money or decide a case, on purpose.

Visa: only Visa Intelligent Commerce counts for this hackathon, and Visa confirmed a VIC credential
from Airi CLI qualifies. Trusted Agent Protocol is not available, so it was removed. A buyer funds a
deal by card: `GET /deals/:id/card` says exactly what to ask Airi for, and `POST` charges the single-use
credential through Airwallex Payment Acceptance (`card-funding.ts`). `pnpm pay:airi <dealId>` is the
buyer's side. A card number must never enter a workflow, because DBOS saves workflow inputs, and must
never be an MCP tool argument, because that puts it in a model's context. So the charge runs in the
request, and a lost answer is settled from the rail by the webhook or the monitor. Proof of capture
always beats an earlier failure. Airwallex pays card money over later in fee-netted batches: the
buyer is credited on capture, and reconciliation treats the amount as not yet on the rail until the
transaction settles. The offer adds a 4% buffer, and the real fee then comes out of the buyer's wallet.
The house is fronting the money until it lands, so a payout in that window can be refused by the rail.
The test card is 4111 1111 1111 1111, limited to US$200 a transaction. A refund or chargeback is not
handled: it appears as an unknown transaction and stops settlement for a decider.

x402: `POST /deals/:id/x402` funds a USD deal on Metal. It answers 402 with what is owed, takes the
signed payment on retry and settles through Metal's facilitator. It records who paid and credits
nothing: the finalized deposit is matched to that record in `depositSettled`, so finality and
reconciliation work as for any deposit. A retry reuses the same authorization, and `settlement_in_doubt` keeps the payment open and answers 202 rather than inviting a second payment. A refusal, including an on-chain mandate limit, is kept on
the deal. Metal has no memo or attestation feature, so refusals are not written on-chain. When a
mandate was used, `verifyMandatePayment` records what the chain proves about it as a `mandate_proof`
deal event, which is what a seller can show if the buyer later denies the purchase.

Durability: everything with an outside effect runs in a DBOS workflow. Where a row is saved and a
workflow started separately, something must recover the gap: rail events retry inside their workflow,
and the monitor restarts deals that were saved but never started. DBOS recovers workflows belonging
to the executor id `local` at launch, so run one process until each instance has its own
`DBOS__VMID` and something recovers a dead instance's work (DBOS Conductor does).

## Evaluating the agents

`pnpm eval` runs `packages/agents/eval` against the real model (needs `ANTHROPIC_API_KEY`, spends
money). Each case has known right answers and answers listed as harmful, and goes through the same
validate-and-retry loop as the gateway. Options: `--trials=3`, `--only=substring`. It exits non-zero
on any harmful answer or under 90% correct. Reports go to `packages/agents/eval/reports` (ignored).

`pnpm demo` runs the mug scenario end to end on the in-memory rail, with no model and no real money. `pnpm demo:live` (`apps/api/src/demo-live.ts`) runs it on real Airwallex, Claude, MCP and Metal, on its own `novate_demo` databases, reusing the same Global Accounts through stable request ids so it spends no account quota after the first run. Stop any dev server first.

Add a case whenever a decision goes wrong in practice. `packages/engine/test/model-view.test.ts`
checks the gateway really shows the model what these cases assume it can see.

## Current state (2026-11-09)

All seven phases are built, including connected-account custody and the operator console. Legal is
out of scope: assume licensed parties operate this.

The agents have been evaluated against the real model. `apps/api/test/sandbox.live.test.ts` (`NOVATE_LIVE=1`, port 4000 behind a tunnel, `pnpm webhook:register <tunnel>` first) runs
the end state with everything real: deposits credited only by webhook, Claude deciding a frozen order,
FX, LOCAL payouts, a switch to net settlement, a payout failing after `PAID`, and reconciliation clean
throughout. `airwallex.live.test.ts` is the same money path without webhooks or a model. Both use the
one sandbox account, so a dev server running at the same time puts their deposits in its suspense and
its reconciliation halts: stop it first, or reset its `opening` row afterwards.

Confirmed by those runs: `source_id` matches transfer, conversion and deposit ids; transaction `amount`
is signed; `goods_purchased` is accepted; `reserved_amount` stays 0 during a payout. The sandbox allows
20 Global Accounts per currency and country (`NO_MORE_VBA_ALLOWED`). Closed accounts still count, so each
run of a live test permanently uses one per member, and members past the limit need the suspense fallback.
Still to check:

- Whether a quote may be used for an amount different from the one quoted.
- Field names in the Airi credential file. `readCredential` in `airi-buyer.ts` tries the likely ones
  and reports the names it found.
- Whether and when a card capture reaches financial transactions. Captures in USD and EUR had not appeared
  minutes later, so it is unknown if the sandbox ever settles them, per attempt or in a batch.
- A card challenge cannot be answered by an agent, so the intent is cancelled. `SKIP_3DS` is sent only with
  `AIRWALLEX_SKIP_3DS=true`, after Airwallex has enabled it. The US$200 card limit is not in any docs.
- Refunds, disputes, card settlement reserves and fallback-currency settlement are not handled; they
  appear as unknown transactions and stop settlement for a decider.

Metal: `MetalRail` over `createMetalClient` switches on with `METAL_RPC_URL` and `METAL_PRIVATE_KEY`. Proven on testnet by `apps/api/test/metal.live.test.ts`: a real buyer paying over x402 through Metal's facilitator, the deposit credited after finality, the seller paid on-chain and reconciliation clean. It needs `NOVATE_LIVE_BUYER_KEY` (a funded testnet key) and runs as the default tenant of a running dev server, because a server that owns a rail refuses other tenants' deposits on it. Metal transfers have no idempotency key, so `rail_outgoing_attempts` is what stops a
double-send. Metal's own "clearing" is pay-per-call micropayments, not this product.

## Airwallex facts (read from docs 2026-11-08, API version 2026-08-21)

Base URLs are `https://api.sandbox.airwallex.com` and `https://api.airwallex.com`. Auth is
`POST /api/v1/authentication/login` with `x-client-id` and `x-api-key`, then a bearer token. Pin
`x-api-version`. Transfer failure fields changed on 2026-06-30.

- Connected accounts: `POST /api/v1/accounts/create`, then submit, KYC, `ACTIVE`. Act for one with
  `x-on-behalf-of`. **Not on by default.** Email devhelp@airwallex.com with the sandbox email and Client
  ID to enable connected accounts and platform payments; they are separate switches. Sandbox businesses
  named "Sandbox Business" are auto-approved, and an EIN is needed before submit.
- Moving funds between accounts: `POST /api/v1/connected_account_transfers/create` (`request_id` max
  50 chars). `POST /api/v1/charges/create` debits a connected account into the platform wallet.
  Pulling by transfer on behalf of an account is "subject to authorization" from that account.
- Holds: no API found to reserve part of a wallet. `reserved_amount` appears on balances only. Funds
  split manual release exists, for payment intents only.
- Global Accounts: `POST /api/v1/global_accounts/create`. A repeated `request_id` gives 400 `DUPLICATED_REQUEST`; list by `nick_name` to find the first. Deposits: `GET /api/v1/deposits`, statuses
  `PENDING`, `SETTLED`, `REJECTED`, `REVERSED`. Sandbox: `POST /api/v1/simulation/deposit/create`.
- Direct debit needs a signed mandate, and the bank account must belong to the Airwallex account's
  business or its UBOs. Mandates via API need Account Manager enablement.
- FX: `GET /api/v1/fx/rates/current`, `POST /api/v1/fx/quotes/create` (validity 1 minute to 24 hours),
  `POST /api/v1/fx/conversions/create` (`request_id` max 64 chars, a repeat is rejected).
- Beneficiaries: `POST /api/v1/beneficiaries/create`, with schemas that vary by country and method. Omit `local_clearing_system` for EUR to NL, or it is refused with `beneficiary_type_unsupported`. `POST /api/v1/beneficiary_api_schemas/generate` and `/beneficiaries/validate` check details without creating anything.
- Transfers: `POST /api/v1/transfers/create`. A repeated `request_id` within 7 days gives
  `duplicate_request_id`, in flight gives 409. A differing `source_currency` books FX implicitly.
  Statuses run to `PAID`, and **`PAID` can still become `FAILED`**. Examples use decimal major units.
  Sandbox: `POST /api/v1/simulation/transfers/{id}/transition`, which answers 500 for `PAID` before `SENT`.
- Reconciliation inputs: `GET /api/v1/balances/current`, `GET /api/v1/balances/history`,
  `GET /api/v1/financial_transactions`, and `TRANSACTION_RECON_REPORT`.
- Webhooks: `POST /api/v1/webhooks/create` (`pnpm webhook:register`), per-subscription secret, HTTPS only. Payment intent events nest the resource in `data.object`; deposits, transfers and conversions put it directly in `data`. This API key may not subscribe to `conversion.overdue`. Verify HMAC-SHA256 of
  `x-timestamp` + raw body against `x-signature`. Delivery is unordered and may repeat, so dedupe on
  event `id`. Retries run for about three days.
- AgentOS does not initiate transfers, FX or payouts, so novate calls the API directly.

From the builder guide (<https://airwallexdev.com/guide>): omit `x-api-version` on FX calls; a quote is
single-use; `request_id` must be 10 to 50 characters; failed transfers end `CANCELLED`, and SENT must
come before PAID in simulation; a SWIFT payout costs a flat EUR 12.85 while LOCAL is free, so prefer
LOCAL or the fee shows as a reconciliation difference; account transfers and charges take a closed
`reason` enum and return `NEW` until `SETTLED`.

The sandbox starts with 10,000,000 in many currencies. A simulated deposit lands in the Global Account's own currency.

From the hackathon Slack: ask for sandbox enablement in Slack, not by email. Payment Acceptance is
unavailable to sandboxes registered in India or Nigeria. Submitting a connected account also needs
`description_of_goods_or_services`, `operating_country`, `account_usage.product_reference` and
`identifications.primary`, passed through `connectedAccount` when provisioning. FX and payouts on behalf
of a brand-new connected account fail with `unconfigured_client_fee` or `fee_unknown` for a few
minutes; novate uses Charges and connected account transfers instead, so it does not act on behalf.

Not confirmed: how connected-account events reach a platform endpoint.

Confirmed live on 2026-11-09, after the sandbox was enabled for native API card access, connected accounts
and platform payments:

- Each deposit costs US$15, whatever its currency. The fee is a separate financial transaction about 0.3s
  later: `source_type: FEE`, `source_id` the deposit id, description `Fee(DEPOSIT_FEE)`. Reconciliation books
  a fee on known money as a house cost (`rail_fee`, paid from the house's float on the rail) and still
  stops for a fee on anything it does not recognise. LOCAL payouts showed no fee.
- Cards: 4111111111111111 captures in USD and EUR, and 4012000300000005 succeeds frictionless, with no
  Skip 3DS enablement. 4012000300000062, the challenge card, fails with `authentication_failed`.
- Submitting a connected account needs `industry_category_code`. `GET /api/v1/reference/industry_categories`
  answers a top-level array of lists whose values hold the codes, e.g. `ICCV3_0812XX` for warehousing and
  distribution.
- Connected account roles: `['BENEFICIAL_OWNER','AUTHORISED_PERSON']` works. A person may hold only one of
  `AUTHORISED_PERSON`, `CONTROLLING_PERSON` and `LEGAL_REPRESENTATIVE`. An account that broke this reached
  `ACTIVE` but stayed refused with 403 "Account is not fully operational". Activating straight after submit
  is fine: `/simulation/accounts/{id}/update_status` with `next_status: 'ACTIVE'`.
- Connected account transfers and charges reach `SETTLED` within seconds and appear as `TRANSFER` and `CHARGE`
  financial transactions with matching `source_id`. A full net settlement in connected custody reconciled
  clean (`airwallex-connected.live.test.ts`).
- List endpoints need both `page_num` and `page_size` if either is given.
- Sandbox webhooks have no delivery guarantee, so polling stays. Events can be re-delivered from
  demo.airwallex.com/app.
