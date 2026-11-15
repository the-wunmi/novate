import { createHash } from 'node:crypto';
import { ALLOWED_ACTIONS } from '@novate/policy';

const STYLE = `
:root {
  --paper: #e6edf0; --sheet: #f6f9fa; --ink: #15303f; --soft: #567080;
  --line: #c3d2d9; --clear: #0d6b5e; --stop: #a8281f;
  font: 16px/1.5 "Avenir Next", Seravek, "Gill Sans", Calibri, sans-serif;
  font-variant-numeric: tabular-nums; color: var(--ink);
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); min-height: 100vh; }
button, input, select { font: inherit; color: inherit; }
:focus-visible { outline: 3px solid var(--clear); outline-offset: 2px; }
#state { padding: 2.25rem clamp(1rem, 4vw, 3.5rem) 1.75rem; background: var(--clear); color: var(--sheet); }
#state.stopped { background: var(--stop); }
#state h1 { margin: 0; font-size: clamp(2rem, 6vw, 3.75rem); line-height: 1.05; font-weight: 500; letter-spacing: -0.02em; }
#state p { margin: 0.6rem 0 0; max-width: 70ch; }
#state button { margin-top: 1rem; background: var(--sheet); color: var(--stop); border: 0; padding: 0.45rem 1rem; cursor: pointer; }
#state { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1rem 3rem; align-items: end; }
#books { margin: 0; padding: 0; list-style: none; text-align: right; font-size: 0.9375rem; }
#books li + li { margin-top: 0.2rem; }
#books .off { font-weight: 600; }
#netting { background: var(--sheet); padding: 1.75rem clamp(1rem, 3vw, 2.25rem) 2rem; }
#netting-title { margin: 0; font-size: clamp(1.6rem, 3.6vw, 2.75rem); font-weight: 500; line-height: 1.12; letter-spacing: -0.015em; max-width: 26ch; }
#netting-note { margin: 0.6rem 0 1.5rem; color: var(--soft); max-width: 66ch; }
.flow { display: grid; grid-template-columns: 7rem minmax(0, 1fr) 8rem; gap: 1rem; align-items: center; margin-bottom: 0.6rem; }
.flow .who { font-weight: 600; }
.flow .track { height: 3.25rem; }
.flow .bar { height: 100%; background: var(--soft); transform-origin: left; }
.flow.moved .bar { background: var(--clear); }
.flow .num { text-align: right; font-size: 1.125rem; }
.grow .bar { animation: grow 800ms cubic-bezier(.2,.7,.2,1) both; }
.flow.moved.grow .bar { animation-delay: 650ms; }
@keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
.detail { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem 3rem; margin-top: 1.5rem; }
.detail h3 { margin: 0 0 0.35rem; }
.detail ul { margin: 0; padding: 0; list-style: none; }
.detail li { display: flex; justify-content: space-between; gap: 1rem; padding: 0.3rem 0; border-bottom: 1px solid var(--line); }
.detail li.back { color: var(--stop); }
.pager { display: flex; gap: 0.75rem; align-items: center; margin-top: 1.25rem; color: var(--soft); font-size: 0.9375rem; }
.pager button { background: none; border: 1px solid var(--line); padding: 0.2rem 0.7rem; cursor: pointer; }
.pager button:disabled { opacity: 0.4; cursor: default; }
.timeline { margin: 0.25rem 0 0.75rem; padding-left: 1.6rem; }
.timeline li { padding: 0.25rem 0; }
.timeline time { color: var(--soft); font-size: 0.8125rem; margin-left: 0.6rem; }
.timeline p { margin: 0.1rem 0 0; color: var(--soft); max-width: 62ch; font-size: 0.9375rem; }
tr.open > td { background: var(--sheet); padding: 0.75rem 1rem; }
td a { color: var(--clear); }
@media (prefers-reduced-motion: reduce) { .grow .bar { animation: none; } }
main { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 2.5rem; padding: 2rem clamp(1rem, 4vw, 3.5rem) 4rem; align-items: start; }
h2 { font-size: 1.25rem; font-weight: 600; margin: 0 0 0.75rem; }
.case { background: var(--sheet); padding: 1.1rem 1.25rem 1.25rem; margin-bottom: 1rem; border-left: 5px solid var(--ink); }
.case .amount { font-size: 1.6rem; font-weight: 500; margin: 0; }
.case .why { margin: 0.25rem 0 0.9rem; max-width: 62ch; }
.case details { margin-bottom: 0.9rem; color: var(--soft); font-size: 0.875rem; }
.case pre { white-space: pre-wrap; word-break: break-word; font-size: 0.8125rem; margin: 0.5rem 0 0; }
.choose { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; }
.choose button { background: transparent; border: 1px solid var(--ink); padding: 0.3rem 0.8rem; cursor: pointer; }
.choose button:hover { background: var(--ink); color: var(--sheet); }
.choose input { border: 1px solid var(--line); background: #fff; padding: 0.3rem 0.5rem; width: 11rem; }
.error { color: var(--stop); margin: 0.6rem 0 0; }
.empty { color: var(--soft); max-width: 44ch; }
.wide { grid-column: 1 / -1; }
.link { background: none; border: 0; padding: 0; color: var(--clear); text-decoration: underline; cursor: pointer; text-align: left; }
.case ol, .case ul { padding-left: 1.25rem; }
.case li p { margin: 0.2rem 0 0.6rem; }
h3 { font-size: 1rem; font-weight: 600; margin: 1rem 0 0.25rem; }
table { width: 100%; border-collapse: collapse; font-size: 0.9375rem; }
td, th { text-align: left; padding: 0.4rem 0.5rem 0.4rem 0; border-bottom: 1px solid var(--line); font-weight: 400; }
th { color: var(--soft); }
td.num, th.num { text-align: right; }
#gate { max-width: 26rem; margin: 18vh auto 0; padding: 0 1rem; }
#gate h1 { font-size: 2.25rem; font-weight: 500; margin: 0 0 1rem; }
#gate label { display: block; margin-bottom: 0.35rem; }
#gate input { width: 100%; padding: 0.5rem; border: 1px solid var(--soft); background: var(--sheet); }
#gate button { margin-top: 0.75rem; padding: 0.5rem 1.25rem; background: var(--ink); color: var(--sheet); border: 0; cursor: pointer; }
[hidden] { display: none !important; }
@media (max-width: 52rem) { main, #state, .detail { grid-template-columns: minmax(0, 1fr); } #books { text-align: left; } .flow { grid-template-columns: minmax(0, 1fr) 6rem; } .flow .track { grid-column: 1 / -1; grid-row: 2; } }
`;

/** What each action asks for. Actions not listed take no input; `reprice` needs the API. */
const FIELDS: Record<string, string[]> = {
  request_evidence: ['note'],
  release_partial: ['bps'],
  draw_margin: ['amount', 'reason'],
  resize_margin: ['bps'],
  margin_call: ['amount'],
  acknowledge: ['note'],
};

const LABELS: Record<string, string> = {
  confirm: 'Confirm the deal',
  cancel: 'Cancel the deal',
  waive: 'Waive the findings',
  request_evidence: 'Ask for corrected evidence',
  release_full: 'Release in full',
  release_partial: 'Release part',
  refund: 'Refund the buyer',
  draw_margin: 'Pay buyer from margin',
  resize_margin: 'Resize margin',
  margin_call: 'Call for margin',
  suspend_agent: 'Suspend the agent',
  reinstate_agent: 'Reinstate the agent',
  no_action: 'Take no action',
  retry_settlement: 'Retry settlement',
  exclude_member: 'Exclude the member',
  halt_settlement: 'Stop settlement',
  acknowledge: 'Acknowledge',
};

const SCRIPT = `
const ALLOWED = ${JSON.stringify(ALLOWED_ACTIONS)};
const FIELDS = ${JSON.stringify(FIELDS)};
const LABELS = ${JSON.stringify(LABELS)};
let key = '';
let me = null;
let desk = { members: [], cycles: [], books: [], lockedInDeals: [] };
let cycleAt = 0;
let shownCycle = null;
let openDeal = null;
let openDetail = null;
let lastSeen = '';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || 'The request failed with status ' + res.status);
  return body;
}

function money(minor, currency) {
  const format = new Intl.NumberFormat(undefined, { style: 'currency', currency });
  return format.format(Number(minor) / 10 ** format.resolvedOptions().maximumFractionDigits);
}

function subjectFields(c) {
  const id = c.context.subject.id;
  return {
    suspend_agent: { agentId: id },
    reinstate_agent: { agentId: id },
    exclude_member: { memberId: c.context.memberIds && c.context.memberIds[0] },
  };
}

function actionControl(c, type, errorLine) {
  const wanted = FIELDS[type] || [];
  const inputs = wanted.map((name) => el('input', { placeholder: name, ariaLabel: name }));
  const button = el('button', { type: 'button', textContent: LABELS[type] });
  button.addEventListener('click', async () => {
    const action = { type, ...(subjectFields(c)[type] || {}) };
    wanted.forEach((name, i) => {
      action[name] = name === 'bps' ? Number(inputs[i].value) : inputs[i].value;
    });
    errorLine.textContent = '';
    try {
      await api('/cases/' + c.id + '/decision', {
        method: 'POST',
        body: JSON.stringify({ bindingHash: c.bindingHash, action }),
      });
      await refresh();
    } catch (err) {
      errorLine.textContent = err.message;
    }
  });
  return [...inputs, button];
}

function caseCard(c) {
  const error = el('p', { className: 'error' });
  const choose = el('div', { className: 'choose' });
  for (const type of ALLOWED[c.kind] || []) {
    if (LABELS[type]) choose.append(...actionControl(c, type, error));
  }
  const amount = BigInt(c.context.amount) > 0n ? money(c.context.amount, c.context.currency) : '';
  return el('article', { className: 'case' },
    el('p', { className: 'amount', textContent: amount }),
    el('p', { className: 'why', textContent: c.reason }),
    el('details', {},
      el('summary', { textContent: 'What the decider saw' }),
      el('pre', { textContent: JSON.stringify(c.shown, null, 2) })),
    choose, error);
}

const sentences = (text) => String(text).replaceAll('.; ', '. ').replaceAll('; ', '. ');
const nameOf = (id) => (desk.members.find((m) => m.id === id) || { name: 'Someone else' }).name;

const EVENTS = {
  submitted: 'Deal submitted', policy_resolved: 'Program rules fixed for this deal',
  verified: 'Agent authority checked', authority_failed: 'Agent was not allowed to make this deal',
  confirmed: 'Both sides confirmed', frozen: 'Frozen for review', held: 'Held for review', waived: 'Findings waived',
  awaiting_funding: 'Waiting for the buyer to fund', escrow_locked: 'Buyer funds locked',
  margin_locked: 'Seller margin locked', awaiting_conditions: 'Waiting for proof of delivery',
  fact_added: 'Evidence added', conditions_evaluated: 'Evidence checked against the rules',
  released: 'Cleared for payment', netted: 'Netted with the other deals', settled: 'Settled',
  cancelled: 'Cancelled', refunded: 'Refunded', card_funded: 'Paid by card', card_refused: 'Card refused',
  held_for_evidence: 'Waiting for corrected evidence', x402_refused: 'Stablecoin payment refused', cycle_failed: 'Settlement failed', mandate_proof: 'On-chain proof of the mandate recorded',
};

const HIDDEN_EVENTS = new Set(['locks_planned', 'policy_resolved']);
const shown = (e) => !HIDDEN_EVENTS.has(e.type) && !(e.type === 'conditions_evaluated' && e.payload.state === 'pending');

function eventLabel(e) {
  if (e.type === 'fact_added') return 'Received ' + (e.payload.kind === 'document' ? e.payload.type : e.payload.kind).replaceAll('_', ' ');
  if (e.type === 'conditions_evaluated') return e.payload.state === 'blocked' ? 'Evidence did not pass' : 'Evidence passed';
  return EVENTS[e.type] || e.type.replaceAll('_', ' ');
}

function dealTimeline(detail) {
  return el('ol', { className: 'timeline' }, ...detail.events.filter(shown).map((e) => {
    const line = el('li', {}, eventLabel(e),
      el('time', { textContent: new Date(e.createdAt).toLocaleTimeString() }));
    const extra = e.payload.reason || e.payload.note;
    if (extra) line.append(el('p', { textContent: sentences(extra) }));
    return line;
  }));
}

function dealSummary(d) {
  const line = (d.terms.lines || [])[0];
  const what = line ? line.quantity + ' ' + line.description : 'a deal';
  return nameOf(d.buyerMemberId) + ' buys ' + what + ' from ' + nameOf(d.sellerMemberId);
}

function dealRows(d) {
  const open = el('button', { type: 'button', className: 'link', textContent: dealSummary(d) });
  open.setAttribute('aria-expanded', String(openDeal === d.id));
  open.addEventListener('click', () => {
    openDeal = openDeal === d.id ? null : d.id;
    refresh().catch(() => undefined);
  });
  const row = el('tr', {},
    el('td', {}, open),
    el('td', { textContent: d.statusReason || d.status.replaceAll('_', ' ') }),
    el('td', { className: 'num', textContent: money(d.amount, d.currency) }));
  if (openDeal !== d.id || !openDetail) return [row];
  return [row, el('tr', { className: 'open' }, el('td', { colSpan: 3 }, dealTimeline(openDetail)))];
}

function flow(kind, who, amount, currency, scale, fresh) {
  const bar = el('div', { className: 'bar' });
  bar.style.width = Math.max(1, Number((amount * 10000n) / scale) / 100) + '%';
  return el('div', { className: 'flow ' + kind + (fresh ? ' grow' : '') },
    el('span', { className: 'who', textContent: who }),
    el('div', { className: 'track' }, bar),
    el('span', { className: 'num', textContent: money(amount, currency) }));
}

const detailLine = (text, amount, currency, className = '') =>
  el('li', { className }, el('span', { textContent: text }), el('span', { textContent: money(amount, currency) }));

function showNetting() {
  const c = desk.cycles[cycleAt];
  $('netting').hidden = !c;
  if (!c) return;
  const fresh = shownCycle !== c.id;
  shownCycle = c.id;
  const currency = c.owed[0].currency;
  const total = (rows, field) => rows.reduce((sum, r) => sum + BigInt(r[field]), 0n);
  const owed = total(c.owed, 'amount');
  const paid = total(c.paid.filter((p) => p.status !== 'reversed'), 'amount');
  const scale = owed > paid ? owed : paid > 0n ? paid : 1n;
  $('netting-title').textContent = money(owed, currency) + ' owed between members. ' + money(paid, currency) + ' paid out.';
  const saved = owed - paid;
  $('netting-note').textContent = saved > 0n
    ? money(saved, currency) + ' was cancelled out by what members owed each other, so that money never had to move.'
    : 'Every amount owed here had to be paid, so netting had nothing to cancel out.';
  const owedList = c.owed.map((o) => detailLine(nameOf(o.payer) + ' owes ' + nameOf(o.payee), o.amount, o.currency));
  const movedList = [
    ...c.converted.map((f) => detailLine('Converted ' + money(f.sellAmount, f.sellCurrency) + ' into', f.buyAmount, f.buyCurrency)),
    ...c.paid.map((p) => p.status === 'reversed'
      ? detailLine('Paid ' + nameOf(p.memberId) + ', then returned', p.amount, p.currency, 'back')
      : detailLine('Paid ' + nameOf(p.memberId), p.amount, p.currency)),
  ];
  const rows = [
    flow('owed', 'Owed', owed, currency, scale, fresh),
    flow('moved', 'Paid out', paid, currency, scale, fresh),
    el('div', { className: 'detail' },
      el('div', {}, el('h3', { textContent: 'What members owed' }), el('ul', {}, ...owedList)),
      el('div', {}, el('h3', { textContent: 'What actually moved' }), el('ul', {}, ...movedList))),
  ];
  const older = el('button', { type: 'button', textContent: 'Earlier cycle', disabled: cycleAt >= desk.cycles.length - 1 });
  const newer = el('button', { type: 'button', textContent: 'Later cycle', disabled: cycleAt === 0 });
  older.addEventListener('click', () => { cycleAt += 1; showNetting(); });
  newer.addEventListener('click', () => { cycleAt -= 1; showNetting(); });
  const pager = el('div', { className: 'pager' }, older, newer,
    el('span', { textContent: 'Cycle ' + (desk.cycles.length - cycleAt) + ' of ' + desk.cycles.length }));
  $('netting-rows').replaceChildren(...rows, pager);
}

function balanceRow(m) {
  const amounts = m.available.filter((a) => BigInt(a.amount) !== 0n).map((a) => money(a.amount, a.currency)).join(', ');
  return el('tr', {},
    el('td', { textContent: m.name }),
    el('td', { className: 'num', textContent: amounts || 'Nothing' }));
}

function showHoldings() {
  const rows = desk.members.map(balanceRow);
  if (desk.lockedInDeals.length) {
    rows.push(el('tr', {},
      el('td', { textContent: 'Locked in open deals' }),
      el('td', { className: 'num', textContent: desk.lockedInDeals.map((a) => money(a.amount, a.currency)).join(', ') })));
  }
  $('holdings').replaceChildren(...rows);
  $('holdings-section').hidden = !rows.length;
}

const RAILS = { airwallex: 'Airwallex', metal: 'Metal' };

function ago(when) {
  const minutes = Math.floor((Date.now() - new Date(when).getTime()) / 60000);
  if (minutes < 1) return 'just now';
  return minutes === 1 ? '1 minute ago' : minutes + ' minutes ago';
}

function showBooks() {
  $('books').replaceChildren(...desk.books.map((b) => {
    const name = RAILS[b.rail] || b.rail;
    return b.status === 'clean'
      ? el('li', { textContent: 'Books match ' + name + ', checked ' + ago(b.checkedAt) })
      : el('li', { className: 'off', textContent: b.differences + ' differences with ' + name + ', found ' + ago(b.checkedAt) });
  }));
}

function callRow(c) {
  return el('tr', {},
    el('td', { textContent: c.memberId }),
    el('td', { textContent: new Date(c.dueAt).toLocaleString() }),
    el('td', { className: 'num', textContent: money(c.amount, c.currency) }));
}

function depositRow(d) {
  const error = el('p', { className: 'error' });
  const member = el('input', { placeholder: 'Member id', ariaLabel: 'Member id' });
  const assign = el('button', { type: 'button', textContent: 'Credit this member' });
  assign.addEventListener('click', async () => {
    error.textContent = '';
    try {
      await api('/tenants/' + me.tenantId + '/deposits/' + d.id + '/assign', {
        method: 'POST',
        body: JSON.stringify({ memberId: member.value.trim() }),
      });
      await refresh();
    } catch (err) {
      error.textContent = err.message;
    }
  });
  return el('tr', {},
    el('td', { textContent: d.depositAccountRef }),
    el('td', { className: 'choose' }, member, assign, error),
    el('td', { className: 'num', textContent: money(d.amount, d.currency) }));
}

const VERDICTS = { good: 'Turned out well', bad: 'Went wrong', neutral: 'Cannot be judged' };

function decisionRow(d) {
  const action = d.resolution ? d.resolution.action.type.replaceAll('_', ' ') : d.status;
  const who = d.resolution ? d.resolution.decider.type : '';
  const open = el('button', { type: 'button', className: 'link', textContent: action });
  open.addEventListener('click', () => showTrail(d.id).catch((err) => {
    $('trail').replaceChildren(el('p', { className: 'error', textContent: err.message }));
  }));
  return el('tr', {},
    el('td', {}, open),
    el('td', { textContent: sentences(d.reason) }),
    el('td', { textContent: who }),
    el('td', { textContent: !d.resolution ? 'No decision was made' : d.verdict ? VERDICTS[d.verdict] : 'Too early to judge' }));
}

function trailStep(s) {
  const verb = s.accepted ? 'decided' : 'proposed, and code refused';
  return el('li', {},
    el('strong', { textContent: s.decider + ' ' + verb + ': ' + s.action.type.replaceAll('_', ' ') }),
    el('p', { textContent: s.rationale }),
    ...s.refusedBecause.map((v) => el('p', { className: 'error', textContent: v })));
}

function trailMoney(m) {
  return el('li', { textContent: m.kind.replaceAll('_', ' ') + ', ' + money(m.amount, m.currency) });
}

async function showTrail(caseId) {
  const t = await api('/tenants/' + me.tenantId + '/decisions/' + caseId);
  $('trail').replaceChildren(el('article', { className: 'case' },
    el('p', { className: 'why', textContent: sentences(t.case.reason) }),
    el('p', { textContent: t.untampered
      ? 'This record still matches what the decider was shown.'
      : 'This record no longer matches what the decider was shown.' }),
    el('ol', {}, ...t.steps.map(trailStep)),
    el('h3', { textContent: 'What happened next' }),
    el('ul', {}, ...t.events.map((e) => el('li', { textContent: e.type.replaceAll('_', ' ') })),
      ...t.money.map(trailMoney)),
    el('details', {},
      el('summary', { textContent: 'What the decider saw' }),
      el('pre', { textContent: JSON.stringify(t.case.shown, null, 2) }))));
  $('trail').scrollIntoView();
}

function recordRow(r) {
  const judged = r.good + r.bad;
  return el('tr', {},
    el('td', { textContent: r.kind.replaceAll('_', ' ') + (r.programKey ? ', ' + r.programKey : '') }),
    el('td', { className: 'num', textContent: r.good + ' of ' + judged }),
    el('td', { className: 'num', textContent: (r.confidenceBps / 100).toFixed(1) + '%' }),
    el('td', { className: 'num', textContent: (r.earnedShareBps / 100).toFixed(0) + '%' }));
}

function showState(t) {
  const stopped = Boolean(t.settlementHaltedAt);
  $('state').className = stopped ? 'stopped' : '';
  $('headline').textContent = stopped ? 'Settlement is stopped' : 'Settlement is running';
  $('detail').textContent = stopped ? t.settlementHaltReason : t.name;
  $('resume').hidden = !stopped || me.kind !== 'house';
}

async function refresh() {
  const base = '/tenants/' + me.tenantId;
  const [tenant, cases, deals, calls, decisions, records, deposits, view, detail] = await Promise.all([
    api(base), api(base + '/cases'), api(base + '/deals'), api(base + '/margin-calls'),
    api(base + '/decisions'), api(base + '/track-record'),
    me.kind === 'house' ? api(base + '/deposits/unattributed') : [],
    api(base + '/desk'),
    openDeal ? api('/deals/' + openDeal) : null,
  ]);
  const seen = JSON.stringify([tenant, cases, deals, calls, decisions, records, deposits, view, detail, cycleAt, openDeal, Math.floor(Date.now() / 60000)]);
  if (seen === lastSeen) return;
  lastSeen = seen;
  const latest = view.cycles[0] && view.cycles[0].id;
  if (latest !== (desk.cycles[0] && desk.cycles[0].id)) cycleAt = 0;
  desk = view;
  openDetail = detail;
  showBooks();
  showNetting();
  showHoldings();
  showState(tenant);
  $('cases').replaceChildren(...(cases.length
    ? cases.map(caseCard)
    : [el('p', { className: 'empty', textContent: 'Nothing needs a person. Agents are handling everything inside your limits.' })]));
  $('deals').replaceChildren(...deals.flatMap(dealRows));
  $('decisions').replaceChildren(...decisions.map(decisionRow));
  $('records-section').hidden = !records.length;
  $('records').replaceChildren(...records.map(recordRow));
  $('calls-section').hidden = !calls.length;
  $('calls').replaceChildren(...calls.map(callRow));
  $('deposits-section').hidden = !deposits.length;
  $('deposits').replaceChildren(...deposits.map(depositRow));
}

async function signIn(value) {
  key = value;
  try {
    me = await api('/me');
    if (me.kind !== 'platform' && me.kind !== 'house') throw new Error('This key cannot use the console. Use a platform or house key.');
    await refresh();
    $('gate').hidden = true;
    $('desk').hidden = false;
    // A refresh rebuilds every row, so it waits while someone is part way through entering something.
    const entering = () =>
      [...$('desk').querySelectorAll('input, textarea')].some((field) => field.value.trim());
    setInterval(() => {
      if (!entering()) refresh().catch(() => undefined);
    }, 5000);
  } catch (err) {
    key = '';
    $('gate-error').textContent = err.message;
  }
}

$('login').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('key').value.trim();
  $('key').value = '';
  signIn(value);
});

// A link can carry the key after the hash, which never reaches the server or its logs.
if (location.hash.startsWith('#key=')) {
  const value = location.hash.slice(5);
  history.replaceState(null, '', location.pathname);
  signIn(value);
}

$('resume').addEventListener('click', async () => {
  await api('/tenants/' + me.tenantId + '/settlement/resume', { method: 'POST' });
  await refresh();
});
`;

const hash = (text: string) => createHash('sha256').update(text).digest('base64');

export const CONSOLE_CSP = [
  "default-src 'none'",
  `script-src 'sha256-${hash(SCRIPT)}'`,
  `style-src 'sha256-${hash(STYLE)}'`,
  "connect-src 'self'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>novate clearing desk</title>
<style>${STYLE}</style>
<div id="gate">
  <h1>Clearing desk</h1>
  <form id="login">
    <label for="key">Your API key</label>
    <input id="key" type="password" autocomplete="off" required>
    <button type="submit">Open the desk</button>
    <p class="error" id="gate-error"></p>
  </form>
</div>
<div id="desk" hidden>
  <header id="state">
    <div>
      <h1 id="headline"></h1>
      <p id="detail"></p>
      <button id="resume" type="button" hidden>Resume settlement</button>
    </div>
    <ul id="books"></ul>
  </header>
  <main>
    <section id="netting" class="wide" hidden>
      <h2 id="netting-title"></h2>
      <p id="netting-note"></p>
      <div id="netting-rows"></div>
    </section>
    <section><h2>Needs your decision</h2><div id="cases"></div></section>
    <section id="holdings-section" hidden>
      <h2>Who holds what</h2>
      <table><thead><tr><th>Member</th><th class="num">Available</th></tr></thead><tbody id="holdings"></tbody></table>
    </section>
    <section id="records-section" hidden>
      <h2>How the agents are doing</h2>
      <table><thead><tr><th>Decision</th><th class="num">Turned out well</th><th class="num">Confidence</th><th class="num">Limit earned</th></tr></thead><tbody id="records"></tbody></table>
    </section>
    <section class="wide">
      <h2>What was decided, and why</h2>
      <div id="trail"></div>
      <table><thead><tr><th>Decision</th><th>Why it came up</th><th>By</th><th>Result</th></tr></thead><tbody id="decisions"></tbody></table>
    </section>
    <section id="calls-section" hidden>
      <h2>Margin calls waiting on members</h2>
      <table><thead><tr><th>Member</th><th>Due</th><th class="num">Short by</th></tr></thead><tbody id="calls"></tbody></table>
    </section>
    <section id="deposits-section" hidden>
      <h2>Money nobody could be matched to</h2>
      <table><thead><tr><th>Received on</th><th>Whose is it?</th><th class="num">Amount</th></tr></thead><tbody id="deposits"></tbody></table>
    </section>
    <section class="wide">
      <h2>Deals</h2>
      <table><thead><tr><th>Deal</th><th>Status</th><th class="num">Amount</th></tr></thead><tbody id="deals"></tbody></table>
    </section>
  </main>
</div>
<script>${SCRIPT}</script>
</html>`;
