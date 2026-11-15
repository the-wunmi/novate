/** Who is making a request. Always derived from a credential, never from the request body. */
export interface Principal {
  kind: 'platform' | 'house' | 'member' | 'agent' | 'inspector' | 'carrier' | 'arbiter';
  /** Key or person identifier, recorded with whatever this principal does. */
  id: string;
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

/** Who may hand over a raw document for the reader. The reader, not the sender, says what it says. */
export const mayFileDocument = (p: Principal, deal: DealParties): boolean =>
  mayAssertFact(p, deal, 'document') || sideOf(p, deal) === 'seller';

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
