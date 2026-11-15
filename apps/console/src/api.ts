import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from './ui.tsx';

/**
 * People sign in with their own account; the server keeps the session in a cookie this code never
 * sees. Every request carries that cookie and the header that proves it came from this console,
 * which is what the server's protection against forged requests looks for.
 */
const headers = (json = true): Record<string, string> => ({
  'x-requested-with': 'novate',
  ...(json ? { 'content-type': 'application/json' } : {}),
});

/** Saves an export, named by `filename` from what the server says it covers. */
export async function download(
  path: string,
  filename: (covers: { from: string; to: string }) => string,
) {
  const res = await fetch(path, { headers: headers(false), credentials: 'same-origin' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.message ?? 'The export failed', body.error);
  }
  const covers = {
    rows: Number(res.headers.get('x-novate-rows') ?? 0),
    from: res.headers.get('x-novate-from') ?? '',
    to: res.headers.get('x-novate-to') ?? '',
  };
  const link = document.createElement('a');
  link.href = URL.createObjectURL(await res.blob());
  link.download = filename(covers);
  link.click();
  URL.revokeObjectURL(link.href);
  return covers;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}) {
  const method = init.method ?? (init.body === undefined ? 'GET' : 'POST');
  const res = await fetch(path, {
    method,
    headers: headers(),
    credentials: 'same-origin',
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Only reads are retried; a change that failed is left for the person to try again.
    const then = method === 'GET' ? ' Retrying.' : '';
    const message =
      res.status === 429
        ? `The server is busy.${then}`
        : body.error === 'rail_error'
          ? body.message
          : res.status >= 500
            ? `Something went wrong on the server.${then}`
            : body.error === 'two_step_required'
              ? 'Turn on two-step sign-in to make changes'
              : (body.message ?? `The request failed with status ${res.status}`);
    throw new ApiError(res.status, message, body.error);
  }
  return body as T;
}

/**
 * How often live screens ask again: often enough to watch settlement happen, rarely enough that
 * several open tabs stay well inside the API's rate limit. Hidden tabs do not ask at all.
 */
export const LIVE_MS = 5_000;

/** Signed-out and forbidden are final; a busy or restarting server is worth asking again. */
export const worthRetrying = (count: number, err: unknown) =>
  count < 4 && !(err instanceof ApiError && err.status < 500 && err.status !== 429);

/**
 * A tenant-scoped read. `path` is relative to `/tenants/:id`. It is read once and again after any
 * change made here; `live` asks again on a timer, for what moves without anyone here acting:
 * cases, cycles, payouts, differences. Several screens may share one read, and it stays live while
 * any of them wants it so.
 */
export function useTenant<T>(
  tenantId: string,
  path: string,
  opts: { enabled?: boolean; live?: boolean } = {},
) {
  return useQuery({
    queryKey: ['tenant', tenantId, path],
    queryFn: () => api<T>(`/tenants/${tenantId}${path}`),
    refetchInterval: opts.live ? LIVE_MS : false,
    enabled: opts.enabled ?? true,
  });
}

/** A live read outside the tenant path, such as a deal or a cycle while it settles. */
export function useLive<T>(key: string, path: string | null) {
  return useQuery({
    queryKey: [key, path],
    queryFn: () => api<T>(path as string),
    refetchInterval: LIVE_MS,
    enabled: path !== null,
  });
}

/**
 * A change a person makes: it runs, says how it went, and every read of the tenant is asked again.
 * `done` is what to say when it worked; `onDone` is anything else the form does after.
 */
export function useAction<V = void, R = unknown>(
  tenantId: string,
  opts: {
    run: (vars: V) => Promise<R>;
    done?: string | ((result: R, vars: V) => string);
    onDone?: (result: R, vars: V) => void;
    onError?: (err: Error) => void;
  },
) {
  const queries = useQueryClient();
  return useMutation({
    mutationFn: opts.run,
    onSuccess: (result, vars) => {
      if (opts.done) toast(typeof opts.done === 'string' ? opts.done : opts.done(result, vars));
      queries.invalidateQueries({ queryKey: ['tenant', tenantId] });
      opts.onDone?.(result, vars);
    },
    onError: (err) => {
      opts.onError?.(err);
      toast(err.message);
    },
  });
}

/** One page of a list, newest first, and the cursor of the page after it. */
export interface Page<T> {
  rows: T[];
  next: string | null;
}

/**
 * A list read a page at a time that stays live: the pages already shown are asked again together,
 * and `more` adds the next one. `filters` become the query; empty ones are left out.
 */
export function usePaged<T, Extra = object>(
  path: string,
  filters: Record<string, string | undefined> = {},
) {
  const query = useInfiniteQuery({
    queryKey: ['paged', path, filters],
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...filters, before: pageParam })) {
        if (v) params.set(k, v);
      }
      const search = params.toString();
      return api<Page<T> & Extra>(search ? `${path}?${search}` : path);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.next ?? undefined,
    refetchInterval: LIVE_MS,
  });
  return {
    rows: query.data?.pages.flatMap((p) => p.rows),
    /** The first page, for what the server says about the whole list. */
    head: query.data?.pages[0],
    error: query.error,
    more: query.hasNextPage ? () => query.fetchNextPage() : null,
    loadingMore: query.isFetchingNextPage,
  };
}

/** A change that needs a second person comes back as a request, not as done. */
export interface Pending {
  status: 'pending_approval';
  approvalId: string;
  kind: string;
  expiresAt: string;
}
export const isPending = (r: unknown): r is Pending =>
  typeof r === 'object' && r !== null && (r as { status?: string }).status === 'pending_approval';
