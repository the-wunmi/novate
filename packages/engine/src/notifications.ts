import { DBOS } from '@dbos-inc/dbos-sdk';
import { deps, isWorkflowControl } from './deps.ts';

/** Everything the house tells the outside world about. A new one is a new line here, nothing else. */
export type Notification =
  | { type: 'case_needs_person'; tenantId: string; caseId: string; kind: string; reason: string }
  | { type: 'settlement_stopped'; tenantId: string; reason: string; caseId?: string }
  | { type: 'rail_event_failed'; rail: string; eventId: string; reason: string }
  | {
      type: 'member_defaulted';
      tenantId: string;
      memberId: string;
      caseId: string;
      reason: string;
    };

/** `id` stays the same across retries, so a receiver can drop a repeat. */
export type DeliveredNotification = Notification & { id: string };

/** About five and a half hours of retrying, doubling from five seconds. */
const DELIVERY_RETRIES = { intervalSeconds: 5, backoffRate: 2, maxAttempts: 12 };

async function deliverNotification(notification: Notification): Promise<void> {
  const id = DBOS.workflowID as string;
  try {
    await DBOS.runStep(() => deps().notifier.deliver({ ...notification, id }), {
      name: 'deliver',
      retriesAllowed: true,
      ...DELIVERY_RETRIES,
    });
  } catch (err) {
    if (isWorkflowControl(err)) throw err;
    console.error(`Notification ${id} (${notification.type}) was never delivered:`, err);
  }
}

const notificationWorkflow = DBOS.registerWorkflow(deliverNotification, {
  name: 'deliverNotification',
});

/** Hand a notification over and carry on. It survives a restart, and a slow receiver holds up nothing. */
export async function notify(notification: Notification): Promise<void> {
  await DBOS.startWorkflow(notificationWorkflow)(notification);
}
