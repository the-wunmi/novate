import { DomainError } from '@novate/core';
import { evalCelBool } from './cel.ts';
import { type Check, PolicyCore, type ProgramSpec } from './schema.ts';

/** Everything a rule may reference. Money is CEL int (minor units); other numbers are double. */
export interface RuleContext {
  deal: {
    amount: bigint;
    currency: string;
    quantity: number;
    category: string;
    unitPrice: bigint;
    shipmentDate?: string;
    attributes: Record<string, unknown>;
  };
  buyer: { id: string; name: string; homeCurrency: string; attributes: Record<string, unknown> };
  seller: { id: string; name: string; homeCurrency: string; attributes: Record<string, unknown> };
  signals: Record<string, Record<string, unknown>>;
}

export interface CheckOutcome {
  id: string;
  action: Check['action'];
  reason: string;
}

export interface ResolvedPolicy {
  programName: string;
  policy: PolicyCore;
  /** Basis points of the deal amount the buyer must lock at acceptance. */
  fundingBps: number;
  /** Basis points of the deal amount the seller must post as margin. */
  marginBps: number;
  overridesApplied: { id: string; reason: string }[];
  marginTrace: string[];
  checks: CheckOutcome[];
  authorityFailures: string[];
}

/**
 * Turn a program into the concrete policy for one deal. Pure and deterministic given its inputs,
 * so the result (plus the context it saw) can be snapshotted and replayed in an audit.
 */
export function resolvePolicy(program: ProgramSpec, ctx: RuleContext): ResolvedPolicy {
  const vars = toCelVars(ctx);

  let core: unknown = pickCore(program);
  const overridesApplied: ResolvedPolicy['overridesApplied'] = [];
  for (const o of program.overrides) {
    if (evalCelBool(o.when, vars)) {
      core = deepMerge(core, o.set);
      overridesApplied.push({ id: o.id, reason: o.reason });
    }
  }
  const parsed = PolicyCore.safeParse(core);
  if (!parsed.success) {
    throw new DomainError('policy_error', 'Overrides produced an invalid policy', {
      issues: parsed.error.issues,
      overridesApplied,
    });
  }
  const policy = parsed.data;

  const fundingBps =
    policy.funding.mode === 'prefunded'
      ? 10_000
      : policy.funding.mode === 'partial'
        ? policy.funding.bps
        : 0;

  const marginTrace: string[] = [];
  let marginBps = 0;
  const m = policy.margin;
  if (m.mode === 'fixed') {
    marginBps = m.bps;
    marginTrace.push(`fixed ${m.bps}bps`);
  } else if (m.mode === 'scored') {
    marginBps = m.baseBps;
    marginTrace.push(`base ${m.baseBps}bps`);
    for (const adj of m.adjustments) {
      if (evalCelBool(adj.when, vars)) {
        marginBps += adj.addBps;
        marginTrace.push(`${adj.addBps >= 0 ? '+' : ''}${adj.addBps}bps ${adj.reason}`);
      }
    }
    const clamped = Math.min(m.maxBps, Math.max(m.minBps, marginBps));
    if (clamped !== marginBps) marginTrace.push(`clamped to ${clamped}bps`);
    marginBps = clamped;
  }

  const checks = policy.checks
    .filter((c) => evalCelBool(c.when, vars))
    .map((c) => ({ id: c.id, action: c.action, reason: c.reason }));

  const authorityFailures = policy.authority.rules
    .filter((r) => !evalCelBool(r.when, vars))
    .map((r) => r.reason);

  return {
    programName: program.name,
    policy,
    fundingBps,
    marginBps,
    overridesApplied,
    marginTrace,
    checks,
    authorityFailures,
  };
}

export function toCelVars(ctx: RuleContext): Record<string, unknown> {
  return { deal: ctx.deal, buyer: ctx.buyer, seller: ctx.seller, signals: ctx.signals };
}

function pickCore(program: ProgramSpec): Record<string, unknown> {
  const { name: _n, description: _d, signals: _s, overrides: _o, ...core } = program;
  return structuredClone(core) as Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Merge `patch` into `base`. Dotted keys address nested fields (`"funding.mode"`).
 * A patch that changes a discriminator (`mode`, `type`) replaces that object rather than merging,
 * so stale fields from the previous variant cannot leak in.
 */
export function deepMerge(base: unknown, patch: Record<string, unknown>): unknown {
  let out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const [rawKey, value] of Object.entries(patch)) {
    const [head, ...rest] = rawKey.split('.') as [string, ...string[]];
    const v = rest.length ? { [rest.join('.')]: value } : value;
    const current = out[head];
    if (isPlainObject(current) && isPlainObject(v) && !changesDiscriminator(current, v)) {
      out = { ...out, [head]: deepMerge(current, v) };
    } else {
      out = { ...out, [head]: v };
    }
  }
  return out;
}

function changesDiscriminator(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return ['mode', 'type'].some((k) => k in b && a[k] !== b[k]);
}
