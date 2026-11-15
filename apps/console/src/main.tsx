import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { type FormEvent, StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Router } from 'wouter';
import { useHashLocation } from 'wouter/use-hash-location';
import { ApiError, api, worthRetrying } from './api.ts';
import './console.css';
import { ErrorBoundary } from './error-boundary.tsx';
import { MemberPortal } from './portal/portal.tsx';
import { SessionProvider } from './session.tsx';
import { Shell } from './shell.tsx';
import { setTimeZone } from './time.ts';
import type { Me } from './types.ts';

// An invite link carries its token after `#/invite/`, so it never reaches a server log.
const invite = location.hash.match(/^#\/invite\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
if (!invite && !location.hash.startsWith('#/')) history.replaceState(null, '', '#/overview');

const client = new QueryClient({
  defaultOptions: {
    queries: {
      retry: worthRetrying,
      retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
      staleTime: 1_000,
    },
  },
});

function Card({
  title,
  lede,
  children,
}: {
  title: string;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="gate">
      <div className="gate-card">
        <img className="gate-mark" src="/console/mark.svg" alt="" width={36} height={36} />
        <h1>{title}</h1>
        {lede && <p className="gate-lede">{lede}</p>}
        {children}
      </div>
    </div>
  );
}

const loginError = (err: unknown) =>
  err instanceof ApiError && err.status === 429
    ? 'Too many attempts. Wait a minute and try again.'
    : err instanceof ApiError && err.code === 'invalid_credentials'
      ? 'That email and password did not match an active account.'
      : err instanceof Error
        ? err.message
        : 'Sign-in failed.';

function SignIn() {
  const queries = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const signIn = useMutation({
    mutationFn: () =>
      api('/auth/login', {
        body: { email: email.trim(), password, ...(needsCode ? { code: code.trim() } : {}) },
      }),
    onSuccess: () => queries.invalidateQueries({ queryKey: ['me'] }),
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'mfa_required') setNeedsCode(true);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    signIn.mutate();
  };
  const error =
    signIn.error &&
    !(signIn.error instanceof ApiError && signIn.error.code === 'mfa_required' && !code)
      ? loginError(signIn.error)
      : null;
  return (
    <Card title="Sign in to novate">
      <form onSubmit={submit}>
        <label htmlFor="email">Email</label>
        <input
          id="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {needsCode && (
          <>
            <label htmlFor="code">Code from your authenticator app</label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              // biome-ignore lint/a11y/noAutofocus: the field appears because the server asked for it
              autoFocus
              required
              pattern="[0-9]{6}"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </>
        )}
        <button type="submit" className="btn primary" disabled={signIn.isPending}>
          Sign in
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Card>
  );
}

/** Opened from an invite link: choose a password and you are signed in. */
function AcceptInvite({ token, onDone }: { token: string; onDone: () => void }) {
  const queries = useQueryClient();
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const accept = useMutation({
    mutationFn: () => api('/auth/invites/accept', { body: { token, password } }),
    onSuccess: () => {
      history.replaceState(null, '', '#/overview');
      onDone();
      queries.invalidateQueries({ queryKey: ['me'] });
    },
  });
  const mismatch = again.length > 0 && again !== password;
  return (
    <Card title="Set your password">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!mismatch) accept.mutate();
        }}
      >
        <label htmlFor="new-password">Password</label>
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={12}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <label htmlFor="again">Same again</label>
        <input
          id="again"
          type="password"
          autoComplete="new-password"
          required
          value={again}
          onChange={(e) => setAgain(e.target.value)}
        />
        <button
          type="submit"
          className="btn primary"
          disabled={accept.isPending || mismatch || password.length < 12}
        >
          Set password and sign in
        </button>
        {mismatch && <p className="error">The two passwords differ.</p>}
        {accept.error && (
          <p className="error" role="alert">
            {accept.error.message}
          </p>
        )}
      </form>
    </Card>
  );
}

function App() {
  const queries = useQueryClient();
  const [inviteToken, setInviteToken] = useState(invite);
  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/me'),
    enabled: !inviteToken,
    retry: worthRetrying,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
  });

  const signOut = async () => {
    await api('/auth/logout', { body: {} }).catch(() => undefined);
    queries.clear();
    history.replaceState(null, '', '#/overview');
    await queries.invalidateQueries({ queryKey: ['me'] });
  };

  if (inviteToken) return <AcceptInvite token={inviteToken} onDone={() => setInviteToken(null)} />;
  if (me.isError) {
    const signedOut = me.error instanceof ApiError && [401, 403].includes(me.error.status);
    return signedOut ? (
      <SignIn />
    ) : (
      <Card title="novate is not answering" lede={(me.error as Error).message}>
        <button type="button" className="btn" onClick={() => me.refetch()}>
          Try again
        </button>
      </Card>
    );
  }
  if (!me.data) return null;
  setTimeZone(me.data.timeZone);
  if (!['platform', 'house', 'member', 'auditor'].includes(me.data.kind) || !me.data.userId) {
    return (
      <Card title="This sign-in cannot open the console">
        <button type="button" className="btn" onClick={signOut}>
          Sign out
        </button>
      </Card>
    );
  }
  if (me.data.kind === 'member') {
    return (
      <Router hook={useHashLocation}>
        <MemberPortal me={me.data} onSignOut={signOut} />
      </Router>
    );
  }
  return (
    <SessionProvider me={me.data}>
      <Router hook={useHashLocation}>
        <Shell onSignOut={signOut} />
      </Router>
    </SessionProvider>
  );
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </QueryClientProvider>
  </StrictMode>,
);
