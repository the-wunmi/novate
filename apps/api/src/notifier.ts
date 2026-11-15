import { createHmac } from 'node:crypto';
import type { Notifier } from '@novate/engine';

const TIMEOUT_MS = 10_000;

/** POSTs each notification, signed over timestamp + body. Throwing is how a retry gets asked for. */
export function webhookNotifier(url: string, secret: string): Notifier {
  return {
    async deliver(notification) {
      const body = JSON.stringify(notification);
      const timestamp = String(Date.now());
      const signature = createHmac('sha256', secret)
        .update(timestamp + body)
        .digest('hex');
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-novate-timestamp': timestamp,
          'x-novate-signature': signature,
        },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Notification endpoint answered ${res.status}`);
    },
  };
}
