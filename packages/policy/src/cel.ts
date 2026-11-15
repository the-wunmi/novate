import { Environment } from '@marcbachmann/cel-js';
import { DomainError } from '@novate/core';

/**
 * Rule expressions are CEL: safe, side-effect free, and guaranteed to terminate.
 *
 * Conventions for the evaluation context:
 * - money amounts are CEL `int` in minor units (bigint in JS), e.g. `deal.amount > 1000000`
 * - counts, ratios and signal values are CEL `double`, e.g. `signals.fx.vol30d > 0.12`
 * Mixed comparisons work; mixed arithmetic needs `double(x)` or `int(x)`.
 */
const env = new Environment({
  unlistedVariablesAreDyn: true,
  enableOptionalTypes: true,
  limits: { maxAstNodes: 500, maxDepth: 32 },
});

const cache = new Map<string, ReturnType<Environment['parse']>>();
const MAX_CACHED = 5_000;

/** Nested comprehensions multiply: seven levels over short lists never finish. */
const MAX_COMPREHENSIONS = 2;
const COMPREHENSION = /\.(map|filter|all|exists|exists_one)\s*\(/g;

function compiled(expr: string) {
  let fn = cache.get(expr);
  if (!fn) {
    if ((expr.match(COMPREHENSION)?.length ?? 0) > MAX_COMPREHENSIONS) {
      throw new DomainError('policy_error', `Too many comprehensions in: ${expr}`);
    }
    try {
      fn = env.parse(expr);
    } catch (err) {
      throw new DomainError('policy_error', `Invalid CEL expression: ${expr}`, {
        cause: (err as Error).message,
      });
    }
    if (cache.size >= MAX_CACHED) cache.clear();
    cache.set(expr, fn);
  }
  return fn;
}

export function validateCel(expr: string): string | null {
  try {
    compiled(expr);
    return null;
  } catch (err) {
    return (err as DomainError).message;
  }
}

export function evalCel(expr: string, context: Record<string, unknown>): unknown {
  try {
    return compiled(expr)(context);
  } catch (err) {
    if (err instanceof DomainError) throw err;
    throw new DomainError('policy_error', `CEL evaluation failed: ${expr}`, {
      cause: (err as Error).message,
    });
  }
}

export function evalCelBool(expr: string, context: Record<string, unknown>): boolean {
  const out = evalCel(expr, context);
  if (typeof out !== 'boolean') {
    throw new DomainError('policy_error', `Expression must return bool: ${expr}`);
  }
  return out;
}

export function evalCelInt(expr: string, context: Record<string, unknown>): bigint {
  const out = evalCel(expr, context);
  if (typeof out === 'bigint') return out;
  if (typeof out === 'number' && Number.isFinite(out)) return BigInt(Math.round(out));
  throw new DomainError('policy_error', `Expression must return a number: ${expr}`);
}
