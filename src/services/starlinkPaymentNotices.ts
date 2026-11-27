/**
 * Starlink payment receipt dispatch.
 *
 * The notification row is inserted inside the same transaction that settles
 * the invoice. This module only runs AFTER that transaction commits, and it
 * claims the PENDING email with an atomic UPDATE before sending. A webhook, a
 * reconciliation sweep and a manual verify can therefore race freely without
 * ever sending the same receipt twice.
 */
import {
  claimStarlinkNotificationEmail,
  getStarlinkReceiptNotification,
  markStarlinkNotificationEmailFailed,
  markStarlinkNotificationEmailSent,
} from '../db/starlink';
import { buildPaymentReceiptEmail } from './starlinkEmailTemplates';
import { sendStarlinkEmail } from './notificationService';

const ACTION_LABELS: Record<string, string> = {
  wallet_topup: 'Wallet top-up',
  data_topup: 'Data top-up',
  kit_purchase: 'Starlink kit purchase',
  plan_change: 'Plan change',
  plan_renewal: 'Plan renewal',
  auto_topup: 'Automatic data top-up',
};

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Never throws; callers fire this with `void` so the request never blocks on SMTP. */
export async function dispatchStarlinkPaymentReceipt(eventKey: string): Promise<void> {
  try {
    const queued = await getStarlinkReceiptNotification(eventKey);
    if (!queued || queued.category !== 'PAYMENT') return;

    const claimed = await claimStarlinkNotificationEmail(eventKey);
    if (!claimed) return; // another worker already owns this receipt

    const meta = (claimed.meta ?? {}) as Record<string, unknown>;
    const kind = String(meta.kind ?? '');
    const template = buildPaymentReceiptEmail({
      fullName: claimed.customer_full_name,
      email: claimed.customer_email,
      invoiceNumber: String(meta.invoiceNumber ?? ''),
      providerReference: String(meta.providerReference ?? ''),
      action: ACTION_LABELS[kind] ?? 'Starlink payment',
      amount: Number(meta.amount ?? 0),
      currency: String(meta.currency ?? 'USD'),
      kitSerial: meta.kitSerial ? String(meta.kitSerial) : null,
      kitNickname: meta.kitNickname ? String(meta.kitNickname) : null,
      walletBalance: numberOrNull(meta.walletBalance),
      dataBalance: numberOrNull(meta.dataBalance),
      invoiceUrl: claimed.link_url ?? undefined,
    });

    const sent = await sendStarlinkEmail(claimed.customer_email, template);
    if (sent) {
      await markStarlinkNotificationEmailSent(eventKey);
    } else {
      await markStarlinkNotificationEmailFailed(eventKey, 'SMTP relay did not accept the receipt');
    }
  } catch (err) {
    try {
      await markStarlinkNotificationEmailFailed(eventKey, err instanceof Error ? err.message : 'Unknown dispatch error');
    } catch {
      /* audit helper must never mask the original error */
    }
    console.error('[starlink] payment receipt dispatch failed:', err);
  }
}
