import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { useTenant } from './api.ts';
import type { Agent, Me, MemberRow, Program, Rail, Tenant } from './types.ts';
import { shortId } from './ui.tsx';

interface Session {
  me: Me;
  tenantId: string;
  isHouse: boolean;
  /** House or auditor: everything the house may read. */
  readsAsHouse: boolean;
  /** False for an auditor, who reads everything and changes nothing. */
  canAct: boolean;
  tenant: Tenant | undefined;
  rails: Rail[];
  members: MemberRow[];
  agents: Agent[];
  programs: Program[];
  programsError: Error | null;
  memberName: (id: string | null | undefined) => string;
  agentName: (id: string | null | undefined) => string;
  programLabel: (id: string) => string;
  /** A deal's program as recorded on its events, "trade@v1", by name: "Trade assurance v1". */
  programByRef: (ref: string) => string;
}

const SessionContext = createContext<Session | null>(null);

/**
 * What every page needs to name things: members, agents, programs, rails and the tenant. Read once,
 * and again after any change made here, not on a timer.
 */
export function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const tenantId = me.tenantId;
  const tenant = useTenant<Tenant>(tenantId, '');
  const rails = useTenant<Rail[]>(tenantId, '/rails');
  const members = useTenant<MemberRow[]>(tenantId, '/members');
  const agents = useTenant<Agent[]>(tenantId, '/agents');
  const programs = useTenant<Program[]>(tenantId, '/programs');

  const value = useMemo<Session>(() => {
    const memberNames = new Map((members.data ?? []).map((m) => [m.id, m.name]));
    const agentNames = new Map((agents.data ?? []).map((a) => [a.id, a.name]));
    const programNames = new Map(
      (programs.data ?? []).map((p) => [p.id, `${p.spec.name} v${p.version}`]),
    );
    return {
      me,
      tenantId,
      isHouse: me.kind === 'house',
      readsAsHouse: me.kind === 'house' || me.kind === 'auditor',
      canAct: me.kind === 'house' || me.kind === 'platform',
      tenant: tenant.data,
      rails: rails.data ?? [],
      members: members.data ?? [],
      agents: agents.data ?? [],
      programs: programs.data ?? [],
      programsError: programs.error,
      memberName: (id) => (id ? (memberNames.get(id) ?? shortId('MB', id)) : 'Nobody'),
      agentName: (id) => (id ? (agentNames.get(id) ?? shortId('AG', id)) : 'No agent'),
      programLabel: (id) => programNames.get(id) ?? 'Program',
      programByRef: (ref) => {
        const [key, version] = ref.split('@');
        const p = (programs.data ?? []).find((x) => x.key === key);
        return `${p?.spec.name ?? key}${version ? ` ${version}` : ''}`;
      },
    };
  }, [
    me,
    tenantId,
    tenant.data,
    rails.data,
    members.data,
    agents.data,
    programs.data,
    programs.error,
  ]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
