/**
 * Calls to a demo server on this machine: as a key holder, or as a person signed in through the
 * console's own login and acting with that session.
 */
export function demoClient(origin: string) {
  async function call<T>(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${origin}${path}`, {
      method,
      headers: { ...headers, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text) as T;
  }

  return {
    api: <T>(key: string, method: string, path: string, body?: unknown) =>
      call<T>(method, path, { authorization: `Bearer ${key}` }, body),

    async signIn(email: string, password: string) {
      const login = await fetch(`${origin}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-requested-with': 'novate', origin },
        body: JSON.stringify({ email, password }),
      });
      if (!login.ok) throw new Error(`${email} could not sign in: ${login.status}`);
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] as string;
      return <T>(method: string, path: string, body?: unknown) =>
        call<T>(method, path, { cookie, origin, 'x-requested-with': 'novate' }, body);
    },
  };
}
