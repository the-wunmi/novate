import { applyBps, maxBig, minBig, toMajor } from '@novate/core';
import { z } from 'zod';
import { evalCelBool, evalCelInt } from './cel.ts';
import { customConditions } from './condition-registry.ts';
import { durationMs } from './duration.ts';
import type { AmountRule, ConditionNode } from './schema.ts';
import { DocumentMatch } from './schema.ts';

/** Evidence attached to a deal. Documents carry `fields` extracted by a person, agent or model. */
export interface Fact {
  id: string;
  kind: string;
  type: string;
  source: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface ConditionDeal {
  amount: bigint;
  currency: string;
  quantity: number;
  shipmentDate?: string;
  description?: string;
  authorisedAt: string;
}

export interface ConditionContext {
  deal: ConditionDeal;
  facts: Fact[];
  now: Date;
  /** Anything else rules may reference (signals, attributes). */
  extra?: Record<string, unknown>;
}

export interface Finding {
  code: string;
  message: string;
  factId?: string;
  /** Can a waiver fact with this code clear it? */
  waivable: boolean;
}

/**
 * Findings as one reason. Rules write messages without a full stop and a document reader may add
 * one, and two documents can report the same thing, so each is said once, in sentences.
 */
export function findingsReason(findings: Pick<Finding, 'message'>[]): string {
  const said = new Map<string, string>();
  for (const f of findings) {
    const message = f.message.trim().replace(/[.\s]+$/, '');
    if (message && !said.has(message.toLowerCase())) said.set(message.toLowerCase(), message);
  }
  return [...said.values()].join('. ');
}

export type ConditionState = 'satisfied' | 'pending' | 'blocked';

export interface ConditionResult {
  state: ConditionState;
  findings: Finding[];
  /** Human-readable trail of what was evaluated. */
  trace: string[];
}

export type ConditionEvaluator = (node: ConditionNode, ctx: ConditionContext) => ConditionResult;

const ok = (trace: string): ConditionResult => ({
  state: 'satisfied',
  findings: [],
  trace: [trace],
});
const wait = (trace: string): ConditionResult => ({
  state: 'pending',
  findings: [],
  trace: [trace],
});

const factsOf = (ctx: ConditionContext, kind: string, type?: string) =>
  ctx.facts.filter((f) => f.kind === kind && (type === undefined || f.type === type));

const latest = (facts: Fact[]) => facts.at(-1);

/** A waiver covers one finding on one piece of evidence, so a worse replacement is not waived. */
function waived(ctx: ConditionContext, finding: Finding): boolean {
  return factsOf(ctx, 'waiver').some(
    (f) => f.data.code === finding.code && f.data.factId === finding.factId,
  );
}

/** `bill_of_lading` reads as "bill of lading", `shipmentDate` as "shipment date". */
const words = (name: string) =>
  name
    .replaceAll('_', ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();

const either = (items: string[]) =>
  items.length > 1 ? `${items.slice(0, -1).join(', ')} or ${items.at(-1)}` : (items[0] ?? '');

const major = (amount: bigint, currency: string) => `${toMajor(amount, currency)} ${currency}`;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
}

const builtins: Record<string, ConditionEvaluator> = {
  documents(node, ctx) {
    const n = node as { require: string[]; match?: unknown };
    const match = DocumentMatch.parse(n.match ?? {});
    const missing = n.require.filter((t) => factsOf(ctx, 'document', t).length === 0);
    if (missing.length) return wait(`documents: waiting for ${missing.join(', ')}`);

    const findings: Finding[] = [];
    for (const type of n.require) {
      const doc = latest(factsOf(ctx, 'document', type)) as Fact;
      const fields = (doc.data.fields ?? {}) as Record<string, unknown>;
      const the = `The ${words(type)}`;

      // Evidence nobody could read is a finding. It must never pass as a match.
      const needed = match.requireFields[type] ?? [];
      const absent = needed.filter((k) => fields[k] === undefined);
      if (Object.keys(fields).length === 0 || absent.length) {
        findings.push({
          code: `${type}.unreadable`,
          message: absent.length
            ? `${the} has no ${either(absent.map(words))}`
            : `${the} could not be read`,
          factId: doc.id,
          waivable: true,
        });
      }

      if (typeof fields.shipmentDate === 'string' && ctx.deal.shipmentDate) {
        const late = daysBetween(ctx.deal.shipmentDate, fields.shipmentDate);
        if (late > match.shipmentDateLateDays) {
          findings.push({
            code: `${type}.shipment_late`,
            message: `${the} shows shipment ${plural(late, 'day')} after the agreed date, more than the ${plural(match.shipmentDateLateDays, 'day')} allowed`,
            factId: doc.id,
            waivable: true,
          });
        }
      }
      if (typeof fields.quantity === 'number') {
        const diffPct = (Math.abs(fields.quantity - ctx.deal.quantity) / ctx.deal.quantity) * 100;
        if (diffPct > match.quantityTolerancePct) {
          findings.push({
            code: `${type}.quantity_mismatch`,
            message: `${the} quantity is ${fields.quantity}, but the deal agreed ${ctx.deal.quantity}`,
            factId: doc.id,
            waivable: true,
          });
        }
      }
      const amt = parseAmount(fields.amount);
      if (fields.amount !== undefined && amt === undefined) {
        findings.push({
          code: `${type}.amount_invalid`,
          message: `${the} amount is not a valid amount`,
          factId: doc.id,
          waivable: false,
        });
      }
      if (amt !== undefined) {
        const diff = amt > ctx.deal.amount ? amt - ctx.deal.amount : ctx.deal.amount - amt;
        if (Number(diff * 10_000n) / Number(ctx.deal.amount) / 100 > match.amountTolerancePct) {
          findings.push({
            code: `${type}.amount_mismatch`,
            message: `${the} amount is ${major(amt, ctx.deal.currency)}, but the deal agreed ${major(ctx.deal.amount, ctx.deal.currency)}`,
            factId: doc.id,
            waivable: true,
          });
        }
      }
      if (fields.currency !== undefined && fields.currency !== ctx.deal.currency) {
        findings.push({
          code: `${type}.currency_mismatch`,
          message: `${the} is in ${String(fields.currency)}, but the deal is in ${ctx.deal.currency}`,
          factId: doc.id,
          waivable: false,
        });
      }
      for (const issue of (doc.data.issues ?? []) as { code: string; message: string }[]) {
        findings.push({
          ...issue,
          code: `${type}.${issue.code}`,
          factId: doc.id,
          waivable: issue.code !== 'embedded_instructions',
        });
      }
    }

    const open = findings.filter((f) => !(f.waivable && waived(ctx, f)));
    if (open.length) {
      return { state: 'blocked', findings: open, trace: open.map((f) => f.message) };
    }
    return ok(`documents: ${n.require.join(', ')} match the deal`);
  },

  inspection(node, ctx) {
    const min = (node as { minPassRate?: number }).minPassRate ?? 0;
    const fact = latest(factsOf(ctx, 'inspection'));
    if (!fact) return wait('inspection: waiting for result');
    const rate = passRate(fact);
    if (rate < min) {
      const finding: Finding = {
        code: 'inspection.below_threshold',
        message: `The inspection passed ${(rate * 100).toFixed(1)}% of the goods, below the ${(min * 100).toFixed(1)}% required`,
        factId: fact.id,
        waivable: true,
      };
      if (waived(ctx, finding)) return ok('inspection: below threshold, waived');
      return { state: 'blocked', findings: [finding], trace: [finding.message] };
    }
    return ok(`inspection: ${(rate * 100).toFixed(1)}% passed`);
  },

  acceptance(_node, ctx) {
    return factsOf(ctx, 'acceptance').length
      ? ok('acceptance: buyer accepted')
      : wait('acceptance: waiting for buyer');
  },

  delivery(_node, ctx) {
    const fact = latest(factsOf(ctx, 'delivery'));
    if (fact?.data.status === 'delivered') return ok('delivery: confirmed');
    return wait(`delivery: ${String(fact?.data.status ?? 'no tracking yet')}`);
  },

  no_dispute(_node, ctx) {
    const open = factsOf(ctx, 'dispute').filter(
      (d) => !factsOf(ctx, 'dispute_resolved').some((r) => r.data.disputeId === d.id),
    );
    if (!open.length) return ok('no_dispute: none open');
    return {
      state: 'blocked',
      findings: open.map((d) => ({
        code: 'dispute.open',
        message: String(d.data.reason ?? 'A party raised a dispute'),
        factId: d.id,
        waivable: false,
      })),
      trace: ['no_dispute: dispute open'],
    };
  },

  elapsed(node, ctx) {
    const after = (node as { after: string }).after;
    const due = Date.parse(ctx.deal.authorisedAt) + durationMs(after);
    return ctx.now.getTime() >= due
      ? ok(`elapsed: ${after} passed`)
      : wait(`elapsed: until ${new Date(due).toISOString()}`);
  },

  cel(node, ctx) {
    const n = node as { expr: string; description?: string };
    const label = n.description ?? n.expr;
    return evalCelBool(n.expr, celContext(ctx))
      ? ok(`cel: ${label}`)
      : wait(`cel: not yet ${label}`);
  },
};

const custom = new Map<string, ConditionEvaluator>();

/** Extension point: platforms can add their own condition types in code. */
export function registerCondition(type: string, evaluator: ConditionEvaluator): void {
  if (type in builtins) throw new Error(`Cannot override built-in condition ${type}`);
  custom.set(type, evaluator);
  customConditions.add(type);
}

function parseAmount(v: unknown): bigint | undefined {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return undefined;
}

export function evaluateCondition(node: ConditionNode, ctx: ConditionContext): ConditionResult {
  if ('all' in node && Array.isArray(node.all)) {
    const results = (node.all as ConditionNode[]).map((n) => evaluateCondition(n, ctx));
    return combine(
      results,
      results.some(is('blocked'))
        ? 'blocked'
        : results.every(is('satisfied'))
          ? 'satisfied'
          : 'pending',
    );
  }
  if ('any' in node && Array.isArray(node.any)) {
    const results = (node.any as ConditionNode[]).map((n) => evaluateCondition(n, ctx));
    if (results.some(is('satisfied'))) {
      return { ...combine(results.filter(is('satisfied')), 'satisfied') };
    }
    return combine(results, results.every(is('blocked')) ? 'blocked' : 'pending');
  }
  if ('not' in node) {
    const r = evaluateCondition(node.not as ConditionNode, ctx);
    const flipped: ConditionState =
      r.state === 'satisfied' ? 'blocked' : r.state === 'blocked' ? 'satisfied' : 'pending';
    return { state: flipped, findings: [], trace: r.trace.map((t) => `not(${t})`) };
  }
  const type = (node as { type: string }).type;
  const evaluator = builtins[type] ?? custom.get(type);
  if (!evaluator) {
    return {
      state: 'blocked',
      findings: [
        {
          code: 'condition.unknown',
          message: `The program uses a condition this house does not know: ${type}`,
          waivable: false,
        },
      ],
      trace: [`unknown condition ${type}`],
    };
  }
  return evaluator(node, ctx);
}

const is = (s: ConditionState) => (r: ConditionResult) => r.state === s;

function combine(results: ConditionResult[], state: ConditionState): ConditionResult {
  return {
    state,
    findings: results.flatMap((r) => r.findings),
    trace: results.flatMap((r) => r.trace),
  };
}

/** The conditions a tree is built from, without the all, any and not around them. */
function leaves(node: ConditionNode): ConditionNode[] {
  if ('all' in node && Array.isArray(node.all))
    return (node.all as ConditionNode[]).flatMap(leaves);
  if ('any' in node && Array.isArray(node.any))
    return (node.any as ConditionNode[]).flatMap(leaves);
  if ('not' in node) return leaves(node.not as ConditionNode);
  return [node];
}

/** What release waits on, as a party would name it: the documents, the buyer's word, or neither. */
export function releaseWaitsFor(node: ConditionNode): 'documents' | 'acceptance' | 'conditions' {
  const types = new Set(leaves(node).map((n) => (n as { type: string }).type));
  return types.has('documents')
    ? 'documents'
    : types.has('acceptance')
      ? 'acceptance'
      : 'conditions';
}

/** How many days late a shipment may be before the documents check finds it; null when none runs. */
export function shipmentTolerance(node: ConditionNode): number | null {
  const days = leaves(node).flatMap((n) =>
    (n as { type: string }).type === 'documents'
      ? [DocumentMatch.parse((n as { match?: unknown }).match ?? {}).shipmentDateLateDays]
      : [],
  );
  return days.length ? Math.min(...days) : null;
}

export function passRate(fact: Fact): number {
  const d = fact.data as { passRate?: number; inspected?: number; passed?: number };
  const raw =
    typeof d.passRate === 'number'
      ? d.passRate
      : d.inspected && typeof d.passed === 'number'
        ? d.passed / d.inspected
        : 0;
  return Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
}

export function releaseAmount(rule: AmountRule, ctx: ConditionContext): bigint {
  switch (rule.type) {
    case 'full':
      return ctx.deal.amount;
    case 'pro_rata_inspection': {
      const fact = latest(factsOf(ctx, 'inspection'));
      if (!fact) return ctx.deal.amount;
      const bps = Math.round(passRate(fact) * 10_000);
      return minBig(maxBig(applyBps(ctx.deal.amount, bps), 0n), ctx.deal.amount);
    }
    case 'cel': {
      const out = evalCelInt(rule.expr, celContext(ctx));
      return minBig(maxBig(out, 0n), ctx.deal.amount);
    }
  }
}

function celContext(ctx: ConditionContext): Record<string, unknown> {
  const inspection = latest(factsOf(ctx, 'inspection'));
  return {
    ...ctx.extra,
    deal: ctx.deal,
    now: ctx.now.toISOString(),
    facts: ctx.facts.map((f) => ({ kind: f.kind, type: f.type, source: f.source, data: f.data })),
    inspection: inspection ? { passRate: passRate(inspection), ...inspection.data } : null,
  };
}

const InspectionData = z
  .object({
    passRate: z.number().min(0).max(1).optional(),
    inspected: z.int().positive().optional(),
    passed: z.int().min(0).optional(),
  })
  .loose()
  .refine(
    (d) => d.passRate !== undefined || (d.inspected !== undefined && d.passed !== undefined),
    {
      message: 'Inspection needs passRate, or inspected and passed',
    },
  )
  .refine((d) => d.inspected === undefined || d.passed === undefined || d.passed <= d.inspected, {
    message: 'Passed cannot exceed inspected',
  });

const DocumentData = z
  .object({
    fields: z
      .object({
        amount: z.union([z.int().min(0), z.string().regex(/^\d+$/)]).optional(),
        quantity: z.number().min(0).optional(),
        currency: z.string().optional(),
        shipmentDate: z.iso.date().optional(),
      })
      .loose()
      .optional(),
    issues: z.array(z.object({ code: z.string(), message: z.string() })).optional(),
  })
  .loose();

const FACT_SCHEMAS: Record<string, z.ZodType> = {
  inspection: InspectionData,
  document: DocumentData,
};

/** Reject malformed evidence at the door, so it can never reach a running workflow. */
export function validateFactData(kind: string, data: unknown): string | null {
  const schema = FACT_SCHEMAS[kind];
  if (!schema) return null;
  const parsed = schema.safeParse(data);
  return parsed.success ? null : parsed.error.issues.map((i) => i.message).join('; ');
}
