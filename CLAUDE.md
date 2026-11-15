# novate

A clearing house run by agents on Airwallex. Agents track every balance, move the money and manage
the risk, with no human in the loop on individual transactions. People set the rules.

The agents run real financial workflows, so build it well: this is not a demo.

Buyer: platforms (agentic commerce, B2B marketplaces) as tenants, businesses as members. Legal is out
of scope: assume licensed parties operate this.
The original pitch is a starting point, not the spec: <https://claude.ai/artifact/BSscrkUVJ6ugcq8QzXbTNo>

## End state to design toward

The mug scenario runs unattended on Airwallex sandbox. Switching programs then makes the same agents
run net settlement.

## Principles

- The agent layer is the core and is shared by every clearing type. It answers: was the agent
  allowed, is this a mistake, does the evidence match and does a mismatch matter, who or what may
  decide, and what should the house do next (resize margin, replan settlement, suspend an agent).
- The money layer varies by program: trade assurance, net settlement, verification-only, real-time
  agent clearing and a full central counterparty. Trade assurance with netting is the reference
  money type that proves the agent core end to end.
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
pnpm test             # offline, under a minute; needs only the Postgres above, never .env
pnpm test:live        # *.live.test.ts: real Airwallex sandbox, Claude and Metal from .env; spends quota
pnpm typecheck
pnpm lint
pnpm dev:api          # http://localhost:4000
pnpm dev:console      # http://localhost:5173/console, proxies the API on :4000
pnpm build:console    # what the API serves at /console
```

`pnpm test` never reads `.env` and never reaches Airwallex, Claude or Metal: rails are `MockRail` or
fakes and the model is stubbed. It uses the docker Postgres (`NOVATE_TEST_DATABASE_URL` overrides it)
and never the dev databases, because a server does work for every tenant in its database and tests
create thousands. `freshTestDatabases` recreates a `novate_test_<suite>_<n>` pair per vitest worker,
so files run in parallel, and the harness launches the engine with `pace: 0.01`, which turns retry
pauses, polls and settle windows from seconds into milliseconds along the same paths. Production
leaves `pace` at 1. Every worker's engine runs with `poolSize: testPoolSize`, and the suites run at
once, so their connections must fit the server: `testWorkers` sets the worker counts,
docker-compose gives Postgres `max_connections=300`, and `freshTestDatabases` refuses to start on a
server too small for them rather than failing at random with "too many clients".

Live tests (`*.live.test.ts`) are excluded from `pnpm test` and run only through `pnpm test:live`
(each package's `vitest.live.config.ts`, which loads `.env`), because they spend real sandbox
resources such as Global Accounts. They run their own engine on test databases; the API's sandbox
test serves on port 4000 itself so webhooks reach it through a tunnel, so stop any dev server first.

## Architecture

TypeScript monorepo (pnpm, turbo), Postgres, DBOS durable workflows, Drizzle, Hono, CEL for rules.

- `packages/core`: money, deal terms, mandates, principals, canonical hashing, domain errors.
- `packages/db`: Drizzle schema and migrations. There is one baseline migration:
  change `schema.ts`, delete `drizzle/`, and run `pnpm --filter @novate/db generate --name=baseline`.
- `packages/ledger`: double-entry, append-only ledger behind a `Ledger` interface.
- `packages/policy`: programs, CEL rules, release conditions, typed actions and `validateAction`.
- `packages/signals`: signal providers resolved once per deal and snapshotted.
- `packages/netting`: pure multilateral, bilateral and gross netting.
- `packages/fx`: pure FX planning and portfolio margin sizing.
- `packages/rails`: `SettlementRail` contract, `AirwallexRail`, `MockRail`.
- `packages/agents`: `ClaudeDecisionAgent`, `ClaudeDocumentReader`. Default model `claude-opus-5-5`.
  Each model decision's record keeps `model`, `promptVersion` (`DECISION_PROMPT_VERSION`, bump on a
  change in meaning) and `promptHash` of the exact instructions.
- `packages/engine`: `deal-workflow.ts`, `cycle-workflow.ts`, `decisions.ts` (the gateway),
  `rail-events.ts`, `reconciliation.ts` (breaks and resuming in `recon-breaks.ts`, openings in
  `rail-opening.ts`, books in `recon-views.ts`, sign-off in `sign-off.ts`), `monitor.ts`,
  `portfolio-margin.ts`, `scheduler.ts`, and one service file per aggregate (`tenants.ts`,
  `members.ts`, `agents.ts`, `api-keys.ts`, `programs.ts`, `deals.ts`, `cycle-runs.ts`).
- `apps/api`: authenticated Hono API. The engine never reads the environment: `apps/api/src/env.ts`
  reads it once and passes the databases and account settings (`secretKey`, `publicUrl`,
  `inviteDelivery`) to `launchEngine`. `app.ts` wires the registrars in `routes/` (people, tenant,
  deals, money, audit). Every route names exactly one guard from `http/guards.ts` before its handler
  (`staff`, `houseOnly`, `platformOnly`, `memberOrStaff`, `ownMember`, `ownMemberMoney`, `anyCaller`,
  `ownAccount`, `open`, `signIn`, `fromConsole` or `operatorKey`); the guard authenticates and
  refuses any other caller, and `guards.test.ts` fails on a route without one. The operator key's
  routes live under `/operator`. Sign-in rate limits key on the socket address, or with
  `NOVATE_TRUST_PROXY_HOPS=n` on the X-Forwarded-For entry n from the right.
- `apps/console`: the operator console, React with Vite and TanStack Query. The API serves its build
  at `/console` under a CSP that allows nothing inline and nothing from elsewhere, so no inline
  scripts or `<style>` blocks. It has no backend of its own: everything it changes goes through the same
  routes and permissions as any other client. People sign in to it with accounts, not keys: a
  member user gets the member portal (`portal/`) instead of the operator screens. Its types
  (`types.ts`) are the engine's read models through `Json<T>` from core, imported as types only, so
  a response that changes shape fails the console's typecheck. Figures the server owns (open deals,
  a rail's books, what release waits on) come from the server, never derived in the browser. Reads
  are fetched once and refetched after any change made through `useAction`; only what moves on its
  own (cases, cycles, payouts, differences, the tenant's halt) passes `live` to poll.

Everything that needs judgement goes through `resolveCase` in `decisions.ts`, and its one path to a
decision is `applyProposal`. Never add a second way to change a deal.

Cycles run one per settlement group (rail, netting, timing). Order: claim, net, convert, fund, then
`commit` posts novation and reads payouts straight from the ledger, then pay and close.

Database steps are exactly-once because DBOS records them in the same transaction. Rail calls are
at-least-once and rely on idempotency keys. A payment with no answer is never assumed failed.

Reconciliation assumes one rail account per tenant, recorded in `railOwners`. Rails with no owner
are not reconciled on a schedule, and `runReconciliation` and `requestRailOpening` answer not found
to any tenant but the owner (`assertRailOwner`); engine tests reconcile through the harness's
`reconcile`, which owns the rail for the call. What an account already holds when a rail is connected is recorded
once at boot (`recordRailOpening`, a `recon_runs` row with status `opening`) and left out of later
comparisons; everything after that must add up. Re-recording it hides differences, so it is held
for a second person like any four-eyes action and needs signed-in users, never a key alone
(`person_required`): one asks (`POST /tenants/:t/rails/:rail/opening`, house, reason, optional
`rebaseBreaks`, answers 202 with an `approvalId` and `absorbed`, per currency what the new opening
hides against what the ledger expects), and a different house user approves it within 24 hours
through `/approvals` (kind `rail_opening`, `GET /tenants/:t/approvals?kind=rail_opening` lists them),
refused if the rail or the ledger moved since the request; the approver's rail read happens before
the approval's transaction (the executor's `prepare`). Either step is
refused while the rail has an unresolved break unless `rebaseBreaks` closes them all as
`opening_rebased`. `approval_requested` keeps the request and `opening_recorded` the approver
and `absorbed`. The first boot records its opening with `recordRailOpening` directly, without an
approval. The latest opening counts, and `/reconciliation/rails` names who recorded it, why, and who approved it.

A difference stops settlement at once, and its case (`reconBreakCase`, workflow id = run id, one open
per rail) goes rules, model, person. Agents may only confirm the stop: acknowledging client money is a
person's (`person_only` check). A person's acknowledgement closes the run's breaks as `explained` and
resumes settlement if only reconciliation stopped it. A break stays open, whatever later runs find,
until a row in `recon_break_resolutions` closes it (`resolveBreak`: posted, explained, written off;
the same difference seen again closes with it). `posted` must name a ledger transfer of the tenant in
the break's currency for exactly its difference, and is refused once a later opening absorbed it. No
cycle or withdrawal runs on a rail with an open break, whatever the halt flag says. Resuming needs a
reason and is refused while any break is open or a reconciliation case waits for a person.
Only the house resumes; the platform may stop. `GET /tenants/:t` names who made the stop in force
(`settlementHaltedBy`, from the control log).
An open `balance_mismatch` on a run that also has item breaks is the same incident, so every count
leaves it out (`countedBreaks`): hold messages, resume blockers, sign-off `openBreaks`, the case
reason ("3 differences with Airwallex, net (300.00) EUR") and `countsAsItem` on each break from
`/reconciliation/breaks`. A recon case's trail (`/decisions/:caseId`) lists the control events on
its rail after it opened (stops, resumes, openings, resolutions) among its `events`.
`signOffBooks` records the end-of-day sign-off: once per business day (the tenant's `timeZone`,
default UTC; the client sends no zone; a unique index holds the day's first) unless
`supersede` with a reason, a note required while breaks are open, and each rail's positions with a
sha256 of them. A reconciliation case is sized per currency as the larger of the absolute net balance
mismatch and the sum of absolute item differences, never adding currencies, and opened in the largest
(`caseDifference`); what the decider sees carries major-unit strings beside every minor amount.

The first boot (`instance-setup.ts`) creates the operator key, a default tenant and its platform key,
and invites a first house user (`NOVATE_ADMIN_EMAIL`, default `admin@localhost`) and platform user
(`NOVATE_PLATFORM_ADMIN_EMAIL`, default `platform@localhost`). It stores only hashes and prints the
keys and invite links once. That tenant owns every rail the server runs and never changes, so adding
tenants never moves the money. The tenant and operator key are one row in `instance_setup`. Tests pass
`isOperator` to `createApp`, so no known key is written to a shared database. `pnpm user:invite
<email> <role> [memberId]` is the way back in when nobody can sign in: it uses the owner database,
re-invites someone who never accepted, resets anyone else, and always prints the link.

People and machines authenticate differently. Keys (`Authorization: Bearer`) are for machines:
trading agents, MCP and a platform's own backend. People have accounts (`users.ts`, `users`,
`user_invites`, `sessions`): an invite link sets a password (at least 12 characters, not the email),
and signing in sets the `novate_session` cookie (HttpOnly, SameSite=Strict, Secure off only for
plain-http localhost and test or development). Only a sha256 of the session token is stored; a
session ends 30 idle minutes or 12 hours after sign-in and is deleted 90 days later, and five failed sign-ins lock an account for
15 minutes (`user_login_locked`). TOTP (RFC 6238, `auth-crypto.ts`) has its secret encrypted with
`NOVATE_SECRET_KEY`. With the tenant setting `requireTwoStep` (default true), a house or
platform session without it gets 403 `two_step_required` on every non-GET route except `/auth/*`. A session resolves to the same `Principal` as a key, with
`userId` and `operator` set to the user's name, so `actorOf` records both on everything they do and
`X-Operator` is ignored. A change made with a cookie must send `Origin` matching the server,
`NOVATE_PUBLIC_URL` or `NOVATE_ALLOWED_ORIGINS`, and `X-Requested-With: novate`; key requests need
neither. The house manages any user, the platform its own and members' users, and only the operator
key makes the first house user. An `auditor` user, invited only by the house, reads whatever the
house reads (every staff GET and CSV, any member's views, `/deals/:id` in full, anyone's sessions)
and changes nothing: the guards refuse every write it sends except to its own account (`/auth/*`),
and the console hides every action from it. `pnpm dev:users` (and `pnpm demo:live`) make demo users
with known passwords (two house people, `house@demo.local` and `checker@demo.local`, so one can
approve what the other asks; platform; and `treasurer@homeware.demo` for the Homeware brand member
once it exists), refused anywhere but a local `novate` or `novate_demo` database, and turn
`requireTwoStep` off there with a `settings_changed` control event.

Invites (`POST /tenants/:t/users`, or `POST /operator/tenants/:t/users` for the operator key) answer `{ user, delivered, expiresAt, inviteUrl? }`. With
`NOVATE_INVITE_DELIVERY=notification` the link goes out as a `user_invite` notification to the
invitee's email and `inviteUrl` is never returned; unset or `inviter`, the inviter gets it once and
`delivered: 'inviter'` is on the response and the `user_invited` event. `POST .../users/:id/invite`
re-sends only to someone still `invited`; anyone who has signed in is reset instead
(`POST .../users/:id/reset`, reason required): sessions revoked, status `invited`, password and TOTP
cleared, `user_reset` recorded, a new link issued the same way. Accepting records `invite_accepted`
(IP, user agent) as the new user. Sign-ins (`user_signed_in`, IP), two-step on and off and password
changes are control events. `GET .../users/:id/sessions` lists a user's sessions (created, last
seen, IP, user agent, `endedReason`), house and auditor for anyone, platform for platform and
member users. `GET .../users` carries `inviteExpiresAt` for someone still invited.
`GET /tenants/:t/keys` lists every key (kind, member, agent, created by, last used, revoked by),
never the key; `POST .../keys/:id/rotate` replaces a member, agent or reviewer key with one of the
same name and scope and revokes the old in one step (house and platform keys come only from the
operator, and only the house revokes them). `last_used_at` moves at most once a minute.

Money-affecting controls need a signed-in person (`personOf`, 403 `person_required` for a key):
manual credit, suspense assignment, break resolution, resume, sign-off, default-fund moves (reason
required, `default_fund_moved`), settings, a change of where a member is paid, and case decisions by
the house or platform. Four eyes
(`four-eyes.ts`, append-only `approval_requests` and `approval_decisions`, the one approval engine):
a manual credit or a write-off above the tenant's `fourEyesAbove[currency]` (minor units,
default 0, so always), a person's case decision above the program ceiling, a new rail opening, and
any change to a member's rail identifiers (`PUT .../members/:id/rail-refs`, kind `rail_refs`,
always; refused on approval if an identifier it changes moved since it was asked) are held and answer `status: 'pending_approval'` with an `approvalId`. Each kind registers an
executor with its approvers, how long a request stays open (72 hours; 24 for an opening) and an
optional `prepare` that reads the outside world before the transaction. `GET /tenants/:t/approvals`
(optional `kind`; `status` `pending`, the default, `decided` for approved, rejected or expired, or
`all`; a population like any other), each row with its `status` and `decision` (who, when, why),
`approvals.csv`, `POST .../approvals/:id/approve` (optional `note`) and `.../reject` (`reason`).
The action runs once, in the approval's transaction, as its requester; the requester never
approves, and nor does anyone tied to them by an invite or reset in 30 days. Deciding locks only
the request's row; settings changes and sign-offs serialise per tenant on an advisory lock
(`lockTenantFor`), never on the tenant row. `PATCH /tenants/:t/settings` (signed-in house, `reason`) sets `requireTwoStep`,
`timeZone` and `fourEyesAbove`; `GET /tenants/:t` shows them under `settings`.

A member has four eyes of its own. Its signed-in users set `withdrawalFourEyesAbove` per currency
(`PUT .../members/:m/controls`, reason required, `member_controls_changed`; a currency not listed is
never held): lowering or adding a threshold applies at once, raising or removing one is held for a
second user of that member (kind `member_controls`). A withdrawal one of its people asks for above it
is held (kind `member_withdrawal`, its id the withdrawal's; a key alone gets `person_required`) and
sent, as the person who asked, once another user of the member approves. Approval checks everything
that would refuse the withdrawal, so a refusal leaves the request open. Asking again with the same
idempotency key answers pending while it waits, sends it once approved and is refused once rejected or
expired; the monitor starts any approved withdrawal that never opened.
Withdrawals by the platform or the house are not held by it. Such requests carry `member_id`: only
users of that member decide them, and a member's `GET /approvals` lists only its own.

Claims: while a deal is open either party may dispute it (a `dispute` fact, which holds release for
review). After settlement, within the program's claim window, the buyer may claim a refund and a seller
paid short by a partial release may claim what was held back. Categories are per side (buyer:
`not_received`, `short`, `quality`, `late`, `other`; seller: `not_paid`, `short_paid`, `other`). The
claim's `exception` case carries `claimant`, and each side has its own remedy (`allowedActions`): a
refund for the buyer, `release_full` for the seller, paid from the buyer's wallet and then as the
buyer's debt (`claim_paid`). An agent may grant either only under `allowRefund`. One side's claim is
refused while the other's is open; it answers with evidence instead. Either party may file evidence as a `claim_evidence` document while the
deal is open or a claim on it is, which no release condition reads.

House keys carry operator-level power (a house person credits funds, with a second person), so only the operator key can issue house keys. In a case, a party to the deal
may only take actions against its own interest (`mayDecideCase`). A deal from a party waits for the
other side to submit the same terms. Rail identifiers are changed only by a signed-in house person
with a second one's approval (`rail_refs` above). Provisioning (`POST .../members/:id/provision`,
house) opens a member's accounts on a rail once, recorded as the caller, and is refused once the
member holds accounts there, since the caller chooses the payee details. A new payee for a member
already provisioned is created on the rail first (`changePayee`, `POST .../members/:id/payee`), and
paying it is the same held `rail_refs` change. `rail_refs_changed` keeps
the old and new values, the approval and its approver.

Settlement accounts belong to a cycle (`Accounts.cycleSettlement`), and a cycle's positions are read
from them. Obligations settle together only within a group of rail, netting, timing and program.

Every ledger account carries its `kind` and owner (`member_id`, `deal_id`, `cycle_id`, `rail`),
written once by `Accounts.*`, and readers query those through `ledger.balances(query)` and joins.
Never take an account code or an idempotency key apart to learn what it means. Program fees post as
`platform_fee` and `house_fee`, or `platform_fee_debt` and `house_fee_debt` when booked as the
member's debt. A member's FX exchange in a cycle is one ledger batch (`member-fx.ts`). A member
sells at an amount rounded up and the rail rounds its own way, so a few minor units can stay in the
house's FX account: `cycleDetail` lists each member's exchange beside the rail's conversion and that
`rounding`.

The house's own money on a rail (`railBooks`, `houseOwn`) is the movement since the opening less
members' money, and `houseOwnParts` says what it is made of: rail fees, card money credited before
the card network paid it over, what members owe, program fees held, FX rounding (with its cycles),
default losses, and the rest as `other`. A currency several rails hold has no total, only the parts
that belong to one rail.

A central counterparty program sets `portfolioMargin`. `portfolio-margin.ts` sizes each member's
collateral across its open positions, in its home currency, from net payables, a volatility stress
and any unrealised loss since the rate at which the position was first marked. The wallet tops it up
automatically. A shortfall becomes a margin call; past its deadline a decider extends it or declares
a default, which makes the member `close_only`: no new positions, existing ones still settle. A
member's failed funding then draws its deal margin, its portfolio margin (converted if need be), the
default fund and last the house. FX is the only market being marked, because goods have no feed.
`/exposure` also answers the house's own `risk` per currency: open payables, the unsecured part
(each member's payables less the escrow behind them at its lock rate, what it is owed and its posted
portfolio margin), the largest unsecured member, the default fund, open margin calls and card money
fronted. `/default-fund` answers a zero balance in every member's home currency and the `waterfall`
of losses by who bore them.

Airwallex deposits are also polled, so a missed webhook cannot lose one. A deposit no member can be matched to is posted to `houseSuspense`, so reconciliation stays clean,
and an operator assigns it. This is the fallback if Airwallex cannot give each member a Global Account.

A withdrawal is a one-payment cycle (`runWithdrawal`, `cycles.kind = 'withdrawal'`, no settlement
group), so it shares a payout's reservation, in-doubt handling and fallback to the wallet, which sets
`returned_to_wallet_at` on the instruction. Money only leaves to the destination the house has on record.
A member's account names why a withdrawal would be refused now (`holds.withdrawals`: `settlement`,
`rail`, `suspended`, `close_only` or `margin_call`) and lists its open margin calls; its settlement
view shows, per group, what the next cycle would take and any shortfall against its free balance,
from the same preview the house reads. Its own users are listed read-only at `.../members/:m/users`,
and `deals.csv` for a member holds only its own deals.

Control actions are audited in `control_events` (`control.ts`): stopping and resuming settlement,
openings, programs, agent and member status (including automatic suspension, `close_only` and the
model's suspensions, as `system` with the case id), rail refs (old and new), manual credits, suspense
assignments, keys issued and revoked, users invited, disabled, enabled and locked out, resolved breaks
and sign-offs, each with who did it and why. A signed-in person is recorded as `actor.userId` and
`actor.operator`; someone holding a key names themselves with `X-Operator`, kept as `actor.operator`.
Either must give a rationale for a decision. Adding a member or an agent (with its mandate) is recorded too.
Every actor carries `via`: `key` (the operator key included, as `kind: operator`), `session` or `system`. A withdrawal keeps who asked on its cycle (`requested_by`) and as `withdrawal_requested`.
Auditors read whole populations: `/decisions`, `/activity`, `/reconciliation` and `/control-events`
take `from`, `to`, `before` and `limit` (at most 500). Every list answers `{ rows, next }`, newest
first on (created_at, id) through `page.ts`: `next` names the page's last row and goes back as
`before`, and Postgres compares that row's own timestamp, so rows written in one transaction are
never skipped or repeated. A cursor names a row of the caller's tenant or places nothing. Activity merges its sources in one order and pages with `source:id`.
Every `.csv` (those four, `decision-records`, `reconciliation-positions` (each check's ledger, rail
and opening per currency, clean runs included), `approvals`,
`ledger`, `payouts`, `deals`, `economics` and a member's `statement.csv`) is every row from `from`
to `to` (default: the last 31 days to now), never a page: past 100,000 rows it answers 413 asking
for a shorter range. Headers say what it covers: `X-Novate-Rows`, `X-Novate-From`, `X-Novate-To`,
and `X-Novate-Range-Defaulted: true` when `from` was not given; the console always sends `from`
(the epoch for "All") and shows the rows and range it got. Every amount is two columns,
`<name>_minor` and `<name>_major` (`moneyColumns` in `csv.ts`). `ledger.csv` names each side's
account kind and owner (member and its name, deal, cycle, rail). `users.csv` and `keys.csv` are the
access review: everyone and every key as they stand now, not a range. Actor
columns include `*_user_id` and `*_via`.

Headline figures are counted by the server over a stated period, never from a loaded page:
`/settlement-summary` (cycles by status and netting per currency, by when each cycle started) and
`/decision-summary` (cases closed, by rule, model or person) take `from` and `to`.

One clock: the tenant's `timeZone` cuts business days, sign-offs and the economics months, and the
console shows every time and cuts every period (this month, last month, custom days) in it, whatever
the browser's zone. `GET /me` carries it as `timeZone`, so the member portal uses it too.

The audit trail holds against the database too. Ledger transfers, deal events and facts, decision
records and outcomes, control events, programs, recon runs, breaks and resolutions, four-eyes
requests and decisions, and `row_history` refuse UPDATE, DELETE and
TRUNCATE by trigger. Settlement instructions, FX conversions, rail events and `tenants` (so every
settlement stop, resume and settings change) are mutable, so a trigger copies every update or
delete to `row_history` (old and new row); `paidAt` is read from it. Users and invites are never
deleted. A case's `shown`, `binding_hash`, `context` and `context_hash` never
change and a case is never deleted; the trail recomputes both hashes (`integrity.shown`,
`integrity.context`). Every table is classified once in `packages/db/src/audit.ts` (audit, historied,
never removed, the case table, or mutable), which holds all the trigger SQL; `runMigrations`
reinstalls the triggers after every migration, and a test fails on an unclassified table. In production run the server as `novate_app`, which can only read and append to
those tables: set `NOVATE_MIGRATION_DATABASE_URL` to the owner's connection and `DATABASE_URL` to
`novate_app`'s. Boot migrates as the owner and applies `grantAppRole` (`packages/db/src/least-privilege.ts`)
again, so new tables get the right grants; `pnpm db:grant` does it by hand. The role is created
without a password: `ALTER ROLE novate_app PASSWORD '...'` once. The DBOS system database may keep
the owner. Dev and tests use the owner throughout.

Anything the outside world should hear about is a `Notification` in `notifications.ts`, sent with
`notify`. Each one is its own durable workflow that retries for hours, so a restart cannot lose it
and a slow receiver holds up nothing. `Notifier` is only the transport. The server posts to
`NOVATE_ALERT_WEBHOOK_URL`, signed with `NOVATE_ALERT_WEBHOOK_SECRET`, or logs if that is not set.

JSON columns take bigints directly: `jsonb` in `packages/db/src/schema.ts` writes them as strings.
API responses do the same through `toJson`. Each JSON column is typed as what is read back: a zod
input type that read models parse (`TenantSettings`, `StoredMandate`, `StoredDealTerms`), or a shape
with amounts as strings (`ReconRunSummary`). Deal event types are a closed list on `deal_events.type`.

Autonomy is earned, not assumed. The monitor records how each model decision turned out
(`judgeDecision`, `decision_outcomes`); a decision about a deal is judged on the first pass after the
deal closes, and open deals are not looked at. With `decisions.autonomy.mode: earned`, a model may decide up
to a share of the tenant's ceiling that rises and falls with the lower confidence bound of its recent
record per case kind. The ceiling itself never moves, and anything past the earned share goes to a
person. `/decisions/:caseId` shows the full trail of a decision, and `shadow.ts` replays past decisions
against a candidate model, instructions or limits without changing anything.

A scheduled cycle with `treasury.mode: agent` is checked first: if everyone can fund it and rates are
calm it just runs, otherwise a model chooses between plans code built. Holds are capped. Reserves
move both ways, and an automated decrease can't go below what the numbers support.

Trading agents can connect over MCP at `/mcp` with their API key. `apps/api/src/agent-tools.ts` is
the whole surface, and every tool runs as the calling key under the same permissions as REST. It has
no way to withdraw money or decide a case, on purpose.

Cards: a buyer funds a deal with a Visa Intelligent Commerce credential from Airi CLI. `GET /deals/:id/card` says exactly what to ask Airi for, and `POST` charges the single-use
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

`pnpm demo` (`apps/api/src/demo.ts`) runs the mug scenario end to end on the in-memory rail, with no model, no real money and no `.env`, on fresh `novate_demo_offline` databases, then keeps serving the console with the demo users on port 4100 (`NOVATE_DEMO_PORT`). `pnpm demo:live` (`apps/api/src/demo-live.ts`) runs it on real Airwallex, Claude, MCP and Metal, on its own `novate_demo` databases, reusing the same Global Accounts through stable request ids so it spends no account quota after the first run. Stop any dev server first.

Add a case whenever a decision goes wrong in practice. `packages/engine/test/model-view.test.ts`
checks the gateway really shows the model what these cases assume it can see.

## Live verification

`apps/api/test/sandbox.live.test.ts` (`pnpm test:live`, port 4000 behind a tunnel, `pnpm webhook:register <tunnel>` first) runs
the end state with everything real: deposits credited only by webhook, Claude deciding a frozen order,
FX, LOCAL payouts, a switch to net settlement, a payout failing after `PAID`, and reconciliation clean
throughout. `airwallex.live.test.ts` is the same money path without webhooks or a model. Both use the
one sandbox account, so a dev server running at the same time puts their deposits in its suspense and
its reconciliation halts: stop it first, or re-record the opening afterwards with
`POST /tenants/:t/rails/airwallex/opening` and `rebaseBreaks: true`, giving the reason, and have a
second person approve it.

Confirmed by those runs: `source_id` matches transfer, conversion and deposit ids; transaction `amount`
is signed; `goods_purchased` is accepted; `reserved_amount` stays 0 during a payout. The sandbox allows
20 Global Accounts per currency and country (`NO_MORE_VBA_ALLOWED`), and closed accounts count too.
Nothing in the docs or API resets it; Airwallex support can. Live tests and the live demo therefore
open each account once under a stable request id and reuse it (`liveAccounts` in the engine's test
harness). Past the cap, opening an account answers `rail_refused` at once, and the member needs its
account details set as a payee change or the suspense fallback.
Unconfirmed:

- Whether a quote may be used for an amount different from the one quoted.
- Field names in the Airi credential file. `readCredential` in `airi-buyer.ts` tries the likely ones
  and reports the names it found.
- Whether and when a card capture reaches financial transactions. Captures in USD and EUR had not appeared
  minutes later, so it is unknown if the sandbox ever settles them, per attempt or in a batch.
- A card challenge cannot be answered by an agent, so the intent is cancelled. `SKIP_3DS` is sent only with
  `AIRWALLEX_SKIP_3DS=true`, after Airwallex has enabled it. The US$200 card limit is not in any docs.
- Refunds, disputes, card settlement reserves and fallback-currency settlement are not handled; they
  appear as unknown transactions and stop settlement for a decider.

Metal: `MetalRail` over `createMetalClient` switches on with `METAL_RPC_URL` and `METAL_PRIVATE_KEY`. Proven on testnet by `apps/api/test/metal.live.test.ts`: a real buyer paying over x402 through Metal's facilitator, the deposit credited after finality, the seller paid on-chain and reconciliation clean. It runs its own engine on fresh databases, and the house wallet funds a throwaway buyer before the rail's opening is recorded (`metal-buyer.ts`, shared with the live demo). Metal transfers have no idempotency key, so `rail_outgoing_attempts` is what stops a
double-send. Metal's own "clearing" is pay-per-call micropayments, not this product.

## Airwallex facts (API version 2026-08-21)

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
- Webhooks: `POST /api/v1/webhooks/create` (`pnpm webhook:register`), per-subscription secret, HTTPS only. Payment intent events nest the resource in `data.object`; deposits, transfers and conversions put it directly in `data`. A sandbox key was refused a subscription to `conversion.overdue`. Verify HMAC-SHA256 of
  `x-timestamp` + raw body against `x-signature`. Delivery is unordered and may repeat, so dedupe on
  event `id`. Retries run for about three days.
- AgentOS does not initiate transfers, FX or payouts, so novate calls the API directly.

From the builder guide (<https://airwallexdev.com/guide>): omit `x-api-version` on FX calls; a quote is
single-use; `request_id` must be 10 to 50 characters; failed transfers end `CANCELLED`, and SENT must
come before PAID in simulation; a SWIFT payout costs a flat EUR 12.85 while LOCAL is free, so prefer
LOCAL or the fee shows as a reconciliation difference; account transfers and charges take a closed
`reason` enum and return `NEW` until `SETTLED`.

The sandbox starts with 10,000,000 in many currencies. A simulated deposit lands in the Global Account's own currency.

From Airwallex developer support: Payment Acceptance is
unavailable to sandboxes registered in India or Nigeria. Submitting a connected account also needs
`description_of_goods_or_services`, `operating_country`, `account_usage.product_reference` and
`identifications.primary`, passed through `connectedAccount` when provisioning. FX and payouts on behalf
of a brand-new connected account fail with `unconfigured_client_fee` or `fee_unknown` for a few
minutes; novate uses Charges and connected account transfers instead, so it does not act on behalf.

Not confirmed: how connected-account events reach a platform endpoint.

Confirmed live, on a sandbox enabled for native API card access, connected accounts and platform
payments:

- Each deposit costs US$15, whatever its currency. The fee is a separate financial transaction about 0.3s
  later: `source_type: FEE`, `source_id` the deposit id, description `Fee(DEPOSIT_FEE)`. Reconciliation books
  a fee on known money as a house cost (`rail_fee`, paid from the house's float on the rail) but
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
- Sandbox webhooks have no delivery guarantee, so novate polls as well. Events can be re-delivered from
  demo.airwallex.com/app.
