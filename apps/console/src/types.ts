// What the API answers: the engine's own read models as JSON, so amounts are strings of minor units
// and times are ISO strings. Types only: nothing from the engine reaches the bundle.
import type { Json } from '@novate/core';
import type * as engine from '@novate/engine';

/** What a route answers when it returns this engine function's result. */
type Out<F extends (...args: never[]) => unknown> = Json<Awaited<ReturnType<F>>>;
type RowOf<F extends (...args: never[]) => unknown> =
  Out<F> extends { rows: (infer R)[] } ? R : Out<F> extends (infer R)[] ? R : never;

export type Minor = string;
export interface Amount {
  currency: string;
  amount: Minor;
}

export type Me = Out<typeof engine.whoAmI>;
export type User = RowOf<typeof engine.listUsers>;
export type InviteResult = Out<typeof engine.inviteUser>;
export type Tenant = Out<typeof engine.tenantStatus>;
export type Rail = RowOf<typeof engine.tenantRails>;

export type CycleView = RowOf<typeof engine.recentCycles>;
export type CycleDetail = Out<typeof engine.cycleDetail>;

export type Deal = RowOf<typeof engine.listDeals>;
export type DealTerms = Deal['terms'];

/** The deal as the house and the platform see it, with its events and cases. */
export type DealDetail = Extract<
  Out<typeof engine.dealDetail>,
  { deal: { policySnapshot: unknown } }
>;
export type Fact = DealDetail['facts'][number];
export type DealEvent = DealDetail['events'][number];
export type CaseRow = RowOf<typeof engine.openCases>;

export type DecisionFeedRow = RowOf<typeof engine.decisionFeed>;
export type Trail = Out<typeof engine.decisionTrail>;
export type Check = Trail['steps'][number]['checks'][number];
export type Recheck = Out<typeof engine.recheckDecision>;
export type Activity = RowOf<typeof engine.activityFeed>;

export type Agent = RowOf<typeof engine.listAgents>;
export type Owner = NonNullable<CaseRow['assignee']>;
export type MemberRow = RowOf<typeof engine.listMembers>;
export type TrackRecord = RowOf<typeof engine.trackRecords>;
export type MarginCall = RowOf<typeof engine.openMarginCalls>;
export type UnattributedDeposit = RowOf<typeof engine.unattributedDepositsOf>;

export type ReconRun = RowOf<typeof engine.reconHistory>;
/** Where one owned rail stands now. */
export type RailBook = RowOf<typeof engine.railBooks>;
/** A difference as its run shows it. */
export type RunBreak = ReconRun['breaks'][number];
/** A difference still open, with who is working it. */
export type ReconBreak = RowOf<typeof engine.openBreaks>;

export type Program = RowOf<typeof engine.listPrograms>;
export type ProgramSpec = Program['spec'];
/** What publishing takes: defaults may be left out. */
export type ProgramSpecInput = Json<Parameters<typeof engine.publishProgram>[2]['spec']>;

export type Statement = Out<typeof engine.memberStatement>;
export type StatementLine = Statement['lines'][number];
export type Exposure = Out<typeof engine.exposure>;
export type HouseRisk = Exposure['risk'][number];
export type SettlementSummary = Out<typeof engine.settlementSummary>;
export type DecisionSummary = Out<typeof engine.decisionSummary>;
export type Economics = Out<typeof engine.economics>;

/** A deal as one of its parties sees it: its history and claims, not the policy or what deciders saw. */
export type PartyDeal = Extract<Out<typeof engine.dealDetail>, { claims: unknown }>;
export type MemberCycle = Out<typeof engine.memberCycle>;
export type MemberAccount = Out<typeof engine.memberAccount>;
export type MemberWithdrawal = RowOf<typeof engine.memberWithdrawals>;
export type MemberSettlement = Out<typeof engine.memberSettlement>;
export type MemberUser = Out<typeof engine.memberUsers>[number];

export type ProblemPayout = RowOf<typeof engine.problemPayouts>;
export type TenantWithdrawal = RowOf<typeof engine.tenantWithdrawals>;
export type ControlEvent = RowOf<typeof engine.controlEventFeed>;
export type UserSession = RowOf<typeof engine.userSessions>;
export type ApiKey = RowOf<typeof engine.listApiKeys>;
export type DefaultFundView = Out<typeof engine.defaultFund>;
export type SettlementPreview = Out<typeof engine.settlementPreview>;
export type ShadowRunDetail = Out<typeof engine.shadowRunDetail>;

type ApprovalRow = RowOf<typeof engine.listApprovals>;
/** A request held for a second person, and what became of it. `P` is what its kind carries. */
export type Approval<P = ApprovalRow['payload']> = Omit<ApprovalRow, 'payload'> & {
  payload: P;
};
