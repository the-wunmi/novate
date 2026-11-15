import { createHmac } from 'node:crypto';
import type { DeliveredNotification } from '@novate/engine';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { webhookNotifier } from '../src/notifier.ts';

const notification: DeliveredNotification = {
  id: 'n1',
  type: 'settlement_stopped',
  tenantId: 't1',
  reason: 'break',
};

describe('webhook notifier', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('signs the timestamp and body', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await webhookNotifier('https://example.test/hook', 'secret').deliver(notification);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    const expected = createHmac('sha256', 'secret')
      .update(`${headers['x-novate-timestamp']}${String(init.body)}`)
      .digest('hex');
    expect(headers['x-novate-signature']).toBe(expected);
  });

  it('throws on a refusal, so the delivery is retried', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    await expect(
      webhookNotifier('https://example.test/hook', 'secret').deliver(notification),
    ).rejects.toThrow('503');
  });
});
