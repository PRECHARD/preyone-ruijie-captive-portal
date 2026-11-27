/**
 * Starlink telemetry notice dispatch.
 *
 * Usage/auto-top-up notices are inserted inside the telemetry transaction with
 * a unique event_key and email_status = PENDING. This module runs only after
 * commit and claims the PENDING row atomically, so a webhook, sync retry or
 * manual sweep can never email the same event twice. PAYMENT receipts keep
 * their existing dedicated dispatcher.
 */
import {
  claimStarlinkNotificationEmail,
  getStarlinkReceiptNotification,
  markStarlinkNotificationEmailFailed,
  markStarlinkNotificationEmailSent,
} from '../db/starlink';
import { buildAutoTopupEmail, buildUsageAlertEmail } from './starlinkEmailTemplates';
import { sendStarlinkEmail } from './notificationService';

function str(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value);
}

function num(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Never throws; callers fire this with `void` so sync requests never block on SMTP. */
export async function dispatchStarlinkQueuedNotice(eventKey: string): Promise<void> {
  try {
    const queued = await getStarlinkReceiptNotification(eventKey);
    if (!queued || (queued.category !== 'USAGE_ALERT' && queued.category !== 'AUTO_TOPUP')) return;

    const claimed = await claimStarlinkNotificationEmail(eventKey);
    if (!claimed) return; // another worker already owns this notice

    const meta = (claimed.meta ?? {}) as Record<string, unknown>;
    const name = queued.customer_full_name;
    const email = queued.customer_email;

    const template = queued.category === 'USAGE_ALERT'
      ? buildUsageAlertEmail({
          fullName: name,
          email,
          threshold: [75, 90, 100].includes(num(meta.threshold)) ? num(meta.threshold) as 75 | 90 | 100 : 75,
          kitSerial: meta.kitSerial ? str(meta.kitSerial) : null,
          kitNickname: meta.kitNickname ? str(meta.kitNickname) : null,
          usedGb: num(meta.usedGb),
          allowanceGb: num(meta.allowanceGb),
          remainingGb: num(meta.remainingGb),
          projectedExhaustionDate: meta.projectedExhaustionDate ? str(meta.projectedExhaustionDate) : null,
          topupUrl: claimed.link_url ?? undefined,
        })
      : buildAutoTopupEmail({
          fullName: name,
          email,
          invoiceNumber: str(meta.invoiceNumber),
          gb: num(meta.gb),
          amount: num(meta.amount),
          walletBalance: num(meta.walletBalance),
          dataBalance: num(meta.dataBalance),
          kitSerial: meta.kitSerial ? str(meta.kitSerial) : null,
          kitNickname: meta.kitNickname ? str(meta.kitNickname) : null,
          invoiceUrl: claimed.link_url ?? undefined,
        });

    const sent = await sendStarlinkEmail(email, template);
    if (sent) {
      await markStarlinkNotificationEmailSent(eventKey);
    } else {
      await markStarlinkNotificationEmailFailed(eventKey, 'SMTP relay did not accept the notice');
    }
  } catch (err) {
    try {
      await markStarlinkNotificationEmailFailed(eventKey, err instanceof Error ? err.message : 'Unknown dispatch error');
    } catch {
      /* audit helper must never mask the original error */
    }
    console.error('[starlink] telemetry notice dispatch failed:', err);
  }
}
