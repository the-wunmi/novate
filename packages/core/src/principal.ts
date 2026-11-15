/** Every kind of credential holder. */
export const PRINCIPAL_KINDS = [
  'platform',
  'house',
  'member',
  'agent',
  'inspector',
  'carrier',
  'arbiter',
  'auditor',
] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/** Keys a tenant issues and rotates itself. House and platform keys come only from the operator. */
export const ISSUABLE_KEY_KINDS = [
  'member',
  'agent',
  'inspector',
  'carrier',
  'arbiter',
] as const satisfies readonly PrincipalKind[];

/** What a person who signs in may be. An auditor reads what the house reads and changes nothing. */
export const USER_ROLES = [
  'house',
  'platform',
  'member',
  'auditor',
] as const satisfies readonly PrincipalKind[];
export type UserRole = (typeof USER_ROLES)[number];

/** Who reads the whole tenant: its staff, and the auditor who reads what they read. */
export const readsAsStaff = (p: Pick<Principal, 'kind'>) =>
  p.kind === 'platform' || p.kind === 'house' || p.kind === 'auditor';

/**
 * Who took an action: a credential holder, the operator, or the house acting on its own. `via` says
 * how they authenticated: a key (the operator's included), a signed-in person's session, or not at all.
 */
export interface ControlActor {
  kind: PrincipalKind | 'operator' | 'system';
  keyId?: string;
  name?: string;
  /** The person who said they were acting, from `X-Operator`. */
  operator?: string;
  /** The signed-in user who acted, when a person authenticated as themselves. */
  userId?: string;
  via: 'key' | 'session' | 'system';
}

/** Who is making a request. Always derived from a credential, never from the request body. */
export interface Principal {
  kind: PrincipalKind;
  /** Key or person identifier, recorded with whatever this principal does. */
  id: string;
  /** The credential's name, for the record of who did what. */
  name?: string;
  /** The person at the keyboard, as they named themselves in `X-Operator`. Recorded, not trusted. */
  operator?: string;
  /** The signed-in user, when a person authenticated as themselves rather than with a key. */
  userId?: string;
  tenantId: string;
  memberId?: string;
  agentId?: string;
}

/** The sides of a deal a principal is able to act for. */
export interface DealParties {
  buyerMemberId: string;
  sellerMemberId: string;
}

export function sideOf(p: Principal, deal: DealParties): 'buyer' | 'seller' | null {
  if (!p.memberId) return null;
  if (p.memberId === deal.buyerMemberId) return 'buyer';
  if (p.memberId === deal.sellerMemberId) return 'seller';
  return null;
}

/** Who may assert what. A party can never certify its own performance. */
export function mayAssertFact(p: Principal, deal: DealParties, kind: string): boolean {
  const side = sideOf(p, deal);
  const trusted = p.kind === 'platform' || p.kind === 'house';
  switch (kind) {
    // A party may file a document to be read, but may not type in what it says.
    case 'document':
      return trusted || p.kind === 'carrier' || p.kind === 'inspector';
    case 'inspection':
      return trusted || p.kind === 'inspector';
    case 'delivery':
      return trusted || p.kind === 'carrier';
    case 'acceptance':
      return side === 'buyer';
    case 'dispute':
      return trusted || side !== null;
    case 'dispute_resolved':
      return trusted || p.kind === 'arbiter';
    // Waivers are written only by the decision gateway.
    case 'waiver':
      return false;
    default:
      return trusted;
  }
}

/** A document either party files in support of its own dispute or claim. No condition reads it. */
export const CLAIM_EVIDENCE = 'claim_evidence';

/**
 * Who may hand over a raw document for the reader. The reader, not the sender, says what it says.
 * The seller files trade documents; either party may file evidence for a dispute or claim.
 */
export const mayFileDocument = (p: Principal, deal: DealParties, type: string): boolean =>
  mayAssertFact(p, deal, 'document') ||
  sideOf(p, deal) === 'seller' ||
  (type === CLAIM_EVIDENCE && sideOf(p, deal) !== null);

export const describePrincipal = (p: Principal) => `${p.kind}:${p.id}`;

/**
 * Who may settle a case as a person. Independent reviewers may take any action. A party to the deal
 * may only take actions that go against its own interest, so nobody can rule in their own favour.
 */
export function mayDecideCase(p: Principal, deal: DealParties | null, actionType: string): boolean {
  if (p.kind === 'platform' || p.kind === 'house') return true;
  if (!deal) return false;
  if (p.kind === 'arbiter') return true;
  if (p.kind !== 'member') return false;
  const side = sideOf(p, deal);
  if (!side) return false;
  // Before any money has moved, either side may walk away.
  if (actionType === 'cancel') return true;
  return side === 'buyer'
    ? actionType === 'waive' || actionType === 'release_full'
    : actionType === 'refund';
}
