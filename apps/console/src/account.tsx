// The signed-in person's own account: password and two-step sign-in. Shared by the operator
// console and the member portal.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from './api.ts';
import type { Me } from './types.ts';
import { Copy, PageHead, Panel, Pill, toast } from './ui.tsx';

const ROLE: Record<string, string> = {
  house: 'House',
  platform: 'Platform',
  member: 'Member',
};

export function AccountPage({ me }: { me: Me }) {
  return (
    <>
      <PageHead title="Your account" />
      <div className="stack">
        <Panel title="Who you are">
          <dl className="facts">
            <dt>Name</dt>
            <dd>{me.name}</dd>
            <dt>Email</dt>
            <dd>{me.email}</dd>
            <dt>Role</dt>
            <dd>{ROLE[me.kind] ?? me.kind}</dd>
          </dl>
        </Panel>
        <TwoStep me={me} />
        <Password />
      </div>
    </>
  );
}

function TwoStep({ me }: { me: Me }) {
  const queries = useQueryClient();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const start = useMutation({
    mutationFn: () => api<{ secret: string; otpauthUrl: string }>('/auth/mfa/setup', { body: {} }),
    onSuccess: setSetup,
    onError: (err) => toast(err.message),
  });
  const change = useMutation({
    mutationFn: (to: 'enable' | 'disable') =>
      api(`/auth/mfa/${to}`, { body: { code: code.trim() } }),
    onSuccess: (_r, to) => {
      toast(to === 'enable' ? 'Two-step sign-in is on' : 'Two-step sign-in is off');
      setSetup(null);
      setCode('');
      queries.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (err) => toast(err.message),
  });
  const codeInput = (
    <input
      className="search"
      inputMode="numeric"
      autoComplete="one-time-code"
      placeholder="6-digit code"
      aria-label="Code from your authenticator app"
      pattern="[0-9]{6}"
      value={code}
      onChange={(e) => setCode(e.target.value)}
    />
  );
  return (
    <Panel
      title="Two-step sign-in"
      aside={<Pill tone={me.mfa ? 'ok' : 'stop'}>{me.mfa ? 'On' : 'Off'}</Pill>}
    >
      <div className="panel-body">
        {me.mfa ? (
          <form
            className="confirm"
            onSubmit={(e) => {
              e.preventDefault();
              change.mutate('disable');
            }}
          >
            {codeInput}
            <button
              type="submit"
              className="btn danger"
              disabled={change.isPending || code.length !== 6}
            >
              Turn off
            </button>
          </form>
        ) : setup ? (
          <form
            className="stack-tight"
            onSubmit={(e) => {
              e.preventDefault();
              change.mutate('enable');
            }}
          >
            <p>Add this key to your authenticator app, then enter its code.</p>
            <p>
              <span className="mono">{setup.secret}</span> <Copy text={setup.secret} />
            </p>
            <span className="confirm">
              {codeInput}
              <button
                type="submit"
                className="btn primary"
                disabled={change.isPending || code.length !== 6}
              >
                Turn on
              </button>
            </span>
          </form>
        ) : (
          <span className="confirm">
            <button
              type="button"
              className="btn primary"
              disabled={start.isPending}
              onClick={() => start.mutate()}
            >
              Set up
            </button>
          </span>
        )}
      </div>
    </Panel>
  );
}

function Password() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const change = useMutation({
    mutationFn: () => api('/auth/password', { body: { current, next } }),
    onSuccess: () => {
      toast('Password changed');
      setCurrent('');
      setNext('');
    },
    onError: (err) => toast(err.message),
  });
  return (
    <Panel title="Password">
      <form
        className="form-inline"
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate();
        }}
      >
        <label className="field">
          Current password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label className="field">
          New password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
        <button type="submit" className="btn" disabled={change.isPending || next.length < 12}>
          Change password
        </button>
      </form>
    </Panel>
  );
}
