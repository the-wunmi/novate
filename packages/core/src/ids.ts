import { randomUUID } from 'node:crypto';

export type Id<Brand extends string> = string & { readonly __brand: Brand };

export type TenantId = Id<'tenant'>;
export type MemberId = Id<'member'>;
export type AgentId = Id<'agent'>;
export type DealId = Id<'deal'>;
export type CycleId = Id<'cycle'>;

export function newId<T extends string = string>(): T {
  return randomUUID() as T;
}
