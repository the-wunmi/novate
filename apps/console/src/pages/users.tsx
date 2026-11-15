// Who and what can act: people with accounts, keys held by agents and integrations, and the
// house's access settings. Everything here is recorded with who changed it and why.
import { useQueryClient } from '@tanstack/react-query';
import { Fragment, useState } from 'react';
import { api, useAction, useTenant } from '../api.ts';
import { ApprovalHistory } from '../approvals.tsx';
import { SnapshotExport } from '../export-menu.tsx';
import { useSession } from '../session.tsx';
import type { ApiKey, InviteResult, User, UserSession } from '../types.ts';
import {
  actorName,
  Copy,
  dateTime,
  EmptyRow,
  formatMajor,
  LoadFailed,
  PageHead,
  Panel,
  Pill,
  parseMinor,
  sentence,
  type Tone,
  toast,
} from '../ui.tsx';

const ROLES: Record<User['role'], string> = {
  house: 'House',
  platform: 'Platform',
  member: 'Member',
  auditor: 'Auditor',
};

const expired = (at: string) => new Date(at).getTime() <= Date.now();

const STATUS: Record<User['status'], [string, Tone]> = {
  active: ['Active', 'ok'],
  invited: ['Invited', 'wait'],
  disabled: ['Disabled', 'stop'],
};

export function Users() {
  const { tenantId, me, memberName, readsAsHouse, canAct } = useSession();
  const users = useTenant<User[]>(tenantId, '/users');
  const [adding, setAdding] = useState(false);
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const shown = (name: string, r: InviteResult) => {
    if (r.inviteUrl) setLink({ name, url: r.inviteUrl });
    else toast(`Link sent to ${r.user.email}`);
  };
  return (
    <>
      <PageHead
        title="People and access"
        actions={
          <span className="toolbar">
            <SnapshotExport path={`/tenants/${tenantId}/users.csv`} name="users" />
            {canAct && (
              <button type="button" className="btn primary" onClick={() => setAdding(!adding)}>
                Invite someone
              </button>
            )}
          </span>
        }
      />
      <div className="stack">
        <Panel title="People">
          {link && (
            <OneTime
              label={`Link for ${link.name}`}
              value={link.url}
              onDone={() => setLink(null)}
            />
          )}
          {adding && (
            <Invite
              onInvited={(name, r) => {
                setAdding(false);
                shown(name, r);
              }}
            />
          )}
          {users.isError && !users.data ? (
            <LoadFailed error={users.error} />
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Two-step</th>
                  <th>Last signed in</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(users.data ?? []).map((u) => (
                  <UserRow
                    key={u.id}
                    user={u}
                    self={u.id === me.userId}
                    member={u.memberId ? memberName(u.memberId) : undefined}
                    onLink={(r) => shown(u.name, r)}
                  />
                ))}
                {users.data && !users.data.length && <EmptyRow cols={6}>No one yet.</EmptyRow>}
              </tbody>
            </table>
          )}
        </Panel>
        <Keys />
        <ApprovalHistory />
        {readsAsHouse && <Settings />}
      </div>
    </>
  );
}

function OneTime({ label, value, onDone }: { label: string; value: string; onDone: () => void }) {
  return (
    <div className="secret">
      {label}, shown once: <span className="mono">{value}</span> <Copy text={value} />{' '}
      <button type="button" className="btn small ghost" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

function Invite({ onInvited }: { onInvited: (name: string, r: InviteResult) => void }) {
  const { tenantId, members, isHouse } = useSession();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<User['role']>('platform');
  const [memberId, setMemberId] = useState('');
  const invite = useAction(tenantId, {
    run: () =>
      api<InviteResult>(`/tenants/${tenantId}/users`, {
        body: {
          email: email.trim(),
          name: name.trim(),
          role,
          ...(role === 'member' ? { memberId } : {}),
        },
      }),
    onDone: (r) => onInvited(name.trim(), r),
  });
  return (
    <form
      className="form-inline"
      onSubmit={(e) => {
        e.preventDefault();
        invite.mutate();
      }}
    >
      <label className="field">
        Name
        <input required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        Email
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        Role
        <select value={role} onChange={(e) => setRole(e.target.value as User['role'])}>
          {isHouse && <option value="house">House</option>}
          <option value="platform">Platform</option>
          <option value="member">Member</option>
          {isHouse && <option value="auditor">Auditor</option>}
        </select>
      </label>
      {role === 'member' && (
        <label className="field">
          Business
          <select required value={memberId} onChange={(e) => setMemberId(e.target.value)}>
            <option value="">Choose a member</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        type="submit"
        className="btn primary"
        disabled={invite.isPending || (role === 'member' && !memberId)}
      >
        Invite
      </button>
    </form>
  );
}

type Asking = null | 'disable' | 'enable' | 'reset';

function UserRow({
  user: u,
  self,
  member,
  onLink,
}: {
  user: User;
  self: boolean;
  member?: string;
  onLink: (r: InviteResult) => void;
}) {
  const { tenantId, isHouse, canAct, me } = useSession();
  const [asking, setAsking] = useState<Asking>(null);
  const [reason, setReason] = useState('');
  const [history, setHistory] = useState(false);
  const act = useAction(tenantId, {
    run: (to: Exclude<Asking, null>) =>
      api<InviteResult | { user: User }>(`/tenants/${tenantId}/users/${u.id}/${to}`, {
        body: { reason: reason.trim() },
      }),
    onDone: (r, to) => {
      setAsking(null);
      setReason('');
      if (to === 'reset') onLink(r as InviteResult);
      else toast(`${u.name} ${to === 'disable' ? 'disabled' : 'enabled'}`);
    },
  });
  const reinvite = useAction(tenantId, {
    run: () => api<InviteResult>(`/tenants/${tenantId}/users/${u.id}/invite`, { body: {} }),
    onDone: onLink,
  });
  const [label, tone] = STATUS[u.status];
  // The house manages anyone; the platform manages platform and member people.
  const canManage = !self && canAct && (isHouse || (u.role !== 'house' && u.role !== 'auditor'));
  const canReview = canManage || me.kind === 'auditor';
  return (
    <Fragment>
      <tr>
        <td className="title-cell">
          {u.name}
          {self && <span className="faint"> (you)</span>}
          <small>{u.email}</small>
        </td>
        <td>
          {ROLES[u.role]}
          {member && <small className="sub-line faint">{member}</small>}
        </td>
        <td>
          <Pill tone={tone}>{label}</Pill>
        </td>
        <td>
          {u.mfa ? 'On' : <span className={u.role === 'member' ? 'muted' : 'error'}>Off</span>}
        </td>
        <td className="muted nowrap">
          {u.lastLoginAt ? dateTime(u.lastLoginAt) : 'Never'}
          {u.inviteExpiresAt && (
            <small className={`sub-line${expired(u.inviteExpiresAt) ? ' error' : ''}`}>
              Invite {expired(u.inviteExpiresAt) ? 'expired' : 'expires'}{' '}
              {dateTime(u.inviteExpiresAt)}
            </small>
          )}{' '}
          {canReview && (
            <button type="button" className="link" onClick={() => setHistory(!history)}>
              {history ? 'Hide' : 'History'}
            </button>
          )}
        </td>
        <td className="num">
          {asking ? (
            <form
              className="confirm"
              onSubmit={(e) => {
                e.preventDefault();
                act.mutate(asking);
              }}
            >
              <input
                className="search"
                required
                placeholder="Reason"
                aria-label="Reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <button
                type="submit"
                className={`btn small${asking === 'enable' ? '' : ' danger'}`}
                disabled={act.isPending || !reason.trim()}
              >
                {sentence(asking)}
              </button>
              <button type="button" className="btn small ghost" onClick={() => setAsking(null)}>
                Cancel
              </button>
            </form>
          ) : (
            canManage && (
              <span className="confirm">
                {u.status === 'invited' && (
                  <button
                    type="button"
                    className="btn small ghost"
                    disabled={reinvite.isPending}
                    onClick={() => reinvite.mutate()}
                  >
                    New link
                  </button>
                )}
                {u.status === 'active' && (
                  <button
                    type="button"
                    className="btn small ghost"
                    onClick={() => setAsking('reset')}
                  >
                    Reset…
                  </button>
                )}
                <button
                  type="button"
                  className={`btn small${u.status === 'disabled' ? '' : ' danger'}`}
                  onClick={() => setAsking(u.status === 'disabled' ? 'enable' : 'disable')}
                >
                  {u.status === 'disabled' ? 'Enable…' : 'Disable…'}
                </button>
              </span>
            )
          )}
        </td>
      </tr>
      {history && (
        <tr className="open">
          <td colSpan={6}>
            <Sessions userId={u.id} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

/** Where and when someone signed in, and how each session ended. */
function Sessions({ userId }: { userId: string }) {
  const { tenantId } = useSession();
  const sessions = useTenant<UserSession[]>(tenantId, `/users/${userId}/sessions`);
  return (
    <table className="breaks">
      <thead>
        <tr>
          <th>Signed in</th>
          <th>Last seen</th>
          <th>From</th>
          <th>Ended</th>
        </tr>
      </thead>
      <tbody>
        {(sessions.data ?? []).map((s) => (
          <tr key={s.createdAt}>
            <td className="nowrap">{dateTime(s.createdAt)}</td>
            <td className="nowrap muted">{dateTime(s.lastSeenAt)}</td>
            <td className="mono muted">{s.ip ?? '—'}</td>
            <td>{s.endedReason ? sentence(s.endedReason) : <Pill tone="ok">Active</Pill>}</td>
          </tr>
        ))}
        {sessions.data && !sessions.data.length && <EmptyRow cols={4}>Never signed in.</EmptyRow>}
      </tbody>
    </table>
  );
}

const KEY_KINDS: Record<string, string> = {
  house: 'House',
  platform: 'Platform',
  member: 'Member',
  agent: 'Agent',
  inspector: 'Inspector',
  carrier: 'Carrier',
  arbiter: 'Reviewer',
};

const KEY_SCOPES: Record<string, string> = {
  house: 'Everything, money included',
  platform: 'Whole tenant',
  member: "Member's own deals and money",
  agent: 'Trades within its mandate',
  inspector: 'Inspections and documents',
  carrier: 'Deliveries and documents',
  arbiter: 'Disputes and cases',
};

/** The keys the platform issues here. Agent keys come with their agent. */
const NEW_KEY_KINDS = ['member', 'arbiter', 'inspector', 'carrier'] as const;

function NewKey({ onIssued }: { onIssued: (r: { name: string; key: string }) => void }) {
  const { tenantId, members } = useSession();
  const [kind, setKind] = useState<(typeof NEW_KEY_KINDS)[number]>('member');
  const [name, setName] = useState('');
  const [memberId, setMemberId] = useState('');
  const issue = useAction(tenantId, {
    run: () =>
      api<{ id: string; key: string }>(`/tenants/${tenantId}/keys`, {
        body: {
          name: name.trim(),
          principal: kind,
          ...(kind === 'member' ? { memberId } : {}),
        },
      }),
    onDone: (r) => onIssued({ name: name.trim(), key: r.key }),
  });
  return (
    <form
      className="form-inline"
      onSubmit={(e) => {
        e.preventDefault();
        issue.mutate();
      }}
    >
      <label className="field">
        Kind
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as (typeof NEW_KEY_KINDS)[number])}
        >
          {NEW_KEY_KINDS.map((k) => (
            <option key={k} value={k}>
              {KEY_KINDS[k]}
            </option>
          ))}
        </select>
      </label>
      {kind === 'member' && (
        <label className="field">
          Member
          <select required value={memberId} onChange={(e) => setMemberId(e.target.value)}>
            <option value="">Choose a member</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        Name
        <input required value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <button
        type="submit"
        className="btn primary"
        disabled={issue.isPending || !name.trim() || (kind === 'member' && !memberId)}
      >
        Issue
      </button>
    </form>
  );
}

/** Credentials held by agents and integrations, not people. */
function Keys() {
  const { tenantId, memberName, agentName, canAct, me } = useSession();
  const keys = useTenant<ApiKey[]>(tenantId, '/keys');
  const [showRevoked, setShowRevoked] = useState(false);
  const [adding, setAdding] = useState(false);
  const [issued, setIssued] = useState<{ name: string; key: string } | null>(null);
  const rotate = useAction(tenantId, {
    run: (k: ApiKey) =>
      api<{ key: string }>(`/tenants/${tenantId}/keys/${k.id}/rotate`, { body: {} }),
    onDone: (r, k) => setIssued({ name: k.name, key: r.key }),
  });
  const revoke = useAction(tenantId, {
    run: (k: ApiKey) => api(`/tenants/${tenantId}/keys/${k.id}`, { method: 'DELETE' }),
    done: (_r, k) => `${k.name} revoked`,
  });
  const rows = (keys.data ?? []).filter((k) => showRevoked || k.active);
  return (
    <Panel
      title="Keys"
      aside={
        <div className="actions">
          <label className="check-toggle">
            <input
              type="checkbox"
              checked={showRevoked}
              onChange={(e) => setShowRevoked(e.target.checked)}
            />
            Revoked
          </label>
          <SnapshotExport path={`/tenants/${tenantId}/keys.csv`} name="keys" />
          {canAct && me.kind === 'platform' && (
            <button type="button" className="btn small" onClick={() => setAdding(!adding)}>
              New key
            </button>
          )}
        </div>
      }
    >
      {adding && (
        <NewKey
          onIssued={(r) => {
            setAdding(false);
            setIssued(r);
          }}
        />
      )}
      {issued && (
        <OneTime
          label={`New key for ${issued.name}`}
          value={issued.key}
          onDone={() => setIssued(null)}
        />
      )}
      <table>
        <thead>
          <tr>
            <th>Key</th>
            <th>Member</th>
            <th>Scope</th>
            <th>Issued</th>
            <th>Last used</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((k) => (
            <tr key={k.id}>
              <td className="title-cell">
                {k.name}
                <small>{KEY_KINDS[k.principal] ?? sentence(k.principal)}</small>
              </td>
              <td className="muted">{k.memberId ? memberName(k.memberId) : '—'}</td>
              <td className="muted">
                {KEY_SCOPES[k.principal] ?? sentence(k.principal)}
                {k.agentId && <small className="sub-line">{agentName(k.agentId)}</small>}
              </td>
              <td className="muted nowrap">
                {dateTime(k.createdAt)}
                <small className="sub-line">{actorName(k.createdBy)}</small>
              </td>
              <td className="muted nowrap">{k.lastUsedAt ? dateTime(k.lastUsedAt) : 'Never'}</td>
              <td className="num">
                {k.active ? (
                  canAct &&
                  !['house', 'platform'].includes(k.principal) && (
                    <span className="confirm">
                      <button
                        type="button"
                        className="btn small ghost"
                        disabled={rotate.isPending}
                        onClick={() => rotate.mutate(k)}
                      >
                        Rotate
                      </button>
                      <button
                        type="button"
                        className="btn small danger"
                        disabled={revoke.isPending}
                        onClick={() => revoke.mutate(k)}
                      >
                        Revoke
                      </button>
                    </span>
                  )
                ) : (
                  <Pill tone="stop">Revoked {k.revokedAt ? dateTime(k.revokedAt) : ''}</Pill>
                )}
              </td>
            </tr>
          ))}
          {keys.data && !rows.length && <EmptyRow cols={6}>No keys.</EmptyRow>}
        </tbody>
      </table>
    </Panel>
  );
}

/** The house's access and control settings. Each change needs a reason and is on the control log. */
function Settings() {
  const { tenantId, tenant, isHouse } = useSession();
  const s = tenant?.settings;
  const [twoStep, setTwoStep] = useState<boolean | null>(null);
  const queries = useQueryClient();
  const [zone, setZone] = useState<string | null>(null);
  const [limits, setLimits] = useState<Record<string, string> | null>(null);
  const [reason, setReason] = useState('');
  const current =
    limits ??
    Object.fromEntries(
      Object.entries(s?.fourEyesAbove ?? {}).map(([c, v]) => [
        c,
        formatMajor(v, c).replaceAll(',', ''),
      ]),
    );
  const parsed = Object.entries(current).map(([c, v]) => [c, parseMinor(v, c)] as const);
  const invalid = parsed.some(([, v]) => v === null);
  const save = useAction(tenantId, {
    run: () =>
      api(`/tenants/${tenantId}/settings`, {
        method: 'PATCH',
        body: {
          ...(twoStep !== null ? { requireTwoStep: twoStep } : {}),
          ...(zone !== null ? { timeZone: zone } : {}),
          ...(limits !== null
            ? { fourEyesAbove: Object.fromEntries(parsed.map(([c, v]) => [c, String(v)])) }
            : {}),
          reason: reason.trim(),
        },
      }),
    done: 'Settings saved',
    onDone: () => {
      // The time zone every screen shows comes with the signed-in person.
      if (zone !== null) queries.invalidateQueries({ queryKey: ['me'] });
      setTwoStep(null);
      setZone(null);
      setLimits(null);
      setReason('');
    },
  });
  const changed = twoStep !== null || zone !== null || limits !== null;
  if (!s) return null;
  return (
    <Panel title="Settings">
      <form
        className="form-inline"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <label className="check-toggle">
          <input
            type="checkbox"
            disabled={!isHouse}
            checked={twoStep ?? s.requireTwoStep}
            onChange={(e) => setTwoStep(e.target.checked)}
          />
          Require two-step sign-in for house and platform
        </label>
        <label className="field">
          Business day time zone
          <input
            disabled={!isHouse}
            value={zone ?? s.timeZone}
            onChange={(e) => setZone(e.target.value)}
          />
        </label>
        {Object.keys(current).map((c) => (
          <label key={c} className="field">
            Second approver above ({c})
            <input
              inputMode="decimal"
              disabled={!isHouse}
              value={current[c]}
              onChange={(e) => setLimits({ ...current, [c]: e.target.value })}
            />
          </label>
        ))}
        {changed && (
          <>
            <input
              className="search"
              required
              placeholder="Reason"
              aria-label="Reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <button
              type="submit"
              className="btn primary"
              disabled={save.isPending || !reason.trim() || invalid}
            >
              Save
            </button>
          </>
        )}
      </form>
    </Panel>
  );
}
