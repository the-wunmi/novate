/**
 * Signals are external (or derived) facts that rules can read: FX volatility, a counterparty's
 * delivery record, country risk, sanctions screening, shipment tracking. Each provider is resolved
 * once per deal and its output is snapshotted with the policy, so decisions can be replayed.
 */

export interface SignalSubject {
  tenantId: string;
  dealId?: string;
  buyerMemberId: string;
  sellerMemberId: string;
  buyerAgentId?: string;
  currency: string;
  amount: bigint;
  category: string;
  attributes: Record<string, unknown>;
}

export interface SignalProvider {
  readonly name: string;
  resolve(subject: SignalSubject): Promise<Record<string, unknown>>;
  /** Used when the provider fails or times out. Without one, the deal cannot proceed. */
  readonly fallback?: Record<string, unknown>;
  readonly timeoutMs?: number;
}

export interface SignalReading {
  values: Record<string, unknown>;
  source: 'live' | 'fallback';
  fetchedAt: string;
  error?: string;
}

export class SignalError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(`Signal ${provider}: ${message}`);
  }
}

export class SignalRegistry {
  readonly #providers = new Map<string, SignalProvider>();

  register(provider: SignalProvider): this {
    this.#providers.set(provider.name, provider);
    return this;
  }

  has(name: string): boolean {
    return this.#providers.has(name);
  }

  names(): string[] {
    return [...this.#providers.keys()];
  }

  async resolve(names: string[], subject: SignalSubject): Promise<Record<string, SignalReading>> {
    const entries = await Promise.all(
      names.map(async (name) => {
        const provider = this.#providers.get(name);
        if (!provider) throw new SignalError(name, 'no provider registered');
        return [name, await this.#read(provider, subject)] as const;
      }),
    );
    return Object.fromEntries(entries);
  }

  async #read(provider: SignalProvider, subject: SignalSubject): Promise<SignalReading> {
    const fetchedAt = new Date().toISOString();
    try {
      const values = await withTimeout(provider.resolve(subject), provider.timeoutMs ?? 5_000);
      return { values, source: 'live', fetchedAt };
    } catch (err) {
      const message = (err as Error).message;
      if (provider.fallback) {
        return { values: provider.fallback, source: 'fallback', fetchedAt, error: message };
      }
      throw new SignalError(provider.name, message);
    }
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Fixed or computed values — config tables, feature flags, test doubles. */
export class StaticSignalProvider implements SignalProvider {
  constructor(
    readonly name: string,
    private readonly values:
      | Record<string, unknown>
      | ((subject: SignalSubject) => Record<string, unknown> | Promise<Record<string, unknown>>),
    readonly fallback?: Record<string, unknown>,
  ) {}

  async resolve(subject: SignalSubject) {
    return typeof this.values === 'function' ? this.values(subject) : this.values;
  }
}

export interface HttpSignalOptions {
  name: string;
  /** Receives the subject and returns the request URL. */
  url: (subject: SignalSubject) => string;
  headers?: Record<string, string>;
  /** Map the JSON response to the values rules will see. */
  map?: (body: unknown, subject: SignalSubject) => Record<string, unknown>;
  fallback?: Record<string, unknown>;
  timeoutMs?: number;
}

/** Any JSON HTTP API as a signal: risk scores, FX feeds, tracking, sanctions screening. */
export class HttpSignalProvider implements SignalProvider {
  readonly name: string;
  readonly fallback?: Record<string, unknown>;
  readonly timeoutMs?: number;

  constructor(private readonly opts: HttpSignalOptions) {
    this.name = opts.name;
    this.fallback = opts.fallback;
    this.timeoutMs = opts.timeoutMs;
  }

  async resolve(subject: SignalSubject) {
    const res = await fetch(this.opts.url(subject), { headers: this.opts.headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    return this.opts.map ? this.opts.map(body, subject) : (body as Record<string, unknown>);
  }
}
