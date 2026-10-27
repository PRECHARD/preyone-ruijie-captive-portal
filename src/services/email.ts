import fs from 'fs';
import path from 'path';
import { buildEmailShell, sendTransactionalEmail } from './notificationService';
import type { MonthEndSummary, SalesReportRow } from './exportService';

/**
 * Month-End / Staff report mail.
 *
 * The visual template lives in `src/templates/email/monthEndReport.html` (dark
 * glassmorphic, same genre as the Cash Handover mail). `tsc` does not copy HTML
 * into `dist`, so we read the source file when present and fall back to an
 * embedded equivalent when running from a compiled build — the mail is never
 * skipped because a static asset was missing.
 */

const MONTH_END_TEMPLATE = 'monthEndReport.html';

function templateCandidates(): string[] {
  return [
    path.resolve(__dirname, '..', 'templates', 'email', MONTH_END_TEMPLATE),
    path.resolve(__dirname, '..', '..', 'src', 'templates', 'email', MONTH_END_TEMPLATE),
    path.resolve(process.cwd(), 'src', 'templates', 'email', MONTH_END_TEMPLATE),
  ];
}

function readTemplate(): string | null {
  for (const candidate of templateCandidates()) {
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function money(value: number, currency = 'USD'): string {
  const formatted = Number(value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${currency === 'USD' ? '$' : ''}${formatted}${currency === 'USD' ? '' : ' ' + currency}`;
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function reconciliationColor(status: MonthEndSummary['reconciliationStatus']): string {
  switch (status) {
    case 'Reconciled':
      return '#22e6a8';
    case 'Overpaid':
      return '#00ccff';
    case 'Shortfall':
    case 'Pending':
      return '#ffcc00';
    default:
      return '#e2e8f0';
  }
}

export interface MonthEndTemplateVars {
  periodLabel: string;
  totalRevenue: string;
  salesCount: number;
  activeHandovers: number;
  activeHandoverValue: string;
  staffCommissions: string;
  reconciliationStatus: string;
  reconciliationDifference: string;
  reconciledValue: string;
  approvedHandoverValue: string;
  staffRowsHtml: string;
  logoUrl: string;
}

/** Pure-ish: fill the template placeholders. */
export function renderMonthEndHtml(vars: MonthEndTemplateVars): string {
  const template = readTemplate();
  const generatedAt = new Date().toLocaleString();
  const year = String(new Date().getFullYear());
  const color = reconciliationColor(vars.reconciliationStatus as MonthEndSummary['reconciliationStatus']);
  const values: Record<string, string> = {
    PERIOD: escapeHtml(vars.periodLabel),
    PERIOD_LABEL: escapeHtml(vars.periodLabel),
    TOTAL_REVENUE: escapeHtml(vars.totalRevenue),
    SALES_COUNT: String(vars.salesCount),
    ACTIVE_HANDOVERS: String(vars.activeHandovers),
    ACTIVE_HANDOVER_VALUE: escapeHtml(vars.activeHandoverValue),
    STAFF_COMMISSIONS: escapeHtml(vars.staffCommissions),
    RECONCILIATION_STATUS: escapeHtml(vars.reconciliationStatus),
    RECONCILIATION_DIFFERENCE: escapeHtml(vars.reconciliationDifference),
    RECONCILED_VALUE: escapeHtml(vars.reconciledValue),
    APPROVED_HANDOVER_VALUE: escapeHtml(vars.approvedHandoverValue),
    RECON_COLOR: color,
    STAFF_ROWS: vars.staffRowsHtml,
    LOGO_URL: escapeHtml(vars.logoUrl),
    GENERATED_AT: escapeHtml(generatedAt),
    YEAR: year,
  };

  if (template) {
    return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, key: string) => values[key] ?? match);
  }

  // Compiled-build fallback: same content, no external file required.
  const body = `
    <div style="text-align:center;margin-bottom:18px">
      <p style="margin:0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#00ccff;font-weight:700">Preyone Admin Console</p>
      <h2 style="margin:6px 0 4px;color:#ffffff;font-size:20px">Month-End Report</h2>
      <p style="margin:0;color:#ffcc00;font-size:13px;font-weight:700">${values.PERIOD_LABEL}</p>
    </div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="8" style="border-collapse:separate;margin-bottom:16px">
      <tr>
        <td width="50%" style="background:rgba(255,204,0,0.07);border:1px solid rgba(255,204,0,0.28);border-radius:12px;padding:14px">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:1.4px;text-transform:uppercase;color:#a9b6cc">Total Monthly Revenue</p>
          <p style="margin:0;font-size:24px;font-weight:800;color:#ffcc00">${values.TOTAL_REVENUE}</p>
        </td>
        <td width="50%" style="background:rgba(0,204,255,0.07);border:1px solid rgba(0,204,255,0.28);border-radius:12px;padding:14px">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:1.4px;text-transform:uppercase;color:#a9b6cc">Total Sales Count</p>
          <p style="margin:0;font-size:24px;font-weight:800;color:#00ccff">${values.SALES_COUNT}</p>
        </td>
      </tr>
      <tr>
        <td width="50%" style="background:rgba(168,85,247,0.07);border:1px solid rgba(168,85,247,0.28);border-radius:12px;padding:14px">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:1.4px;text-transform:uppercase;color:#a9b6cc">Active Cash Handovers</p>
          <p style="margin:0;font-size:24px;font-weight:800;color:#c084fc">${values.ACTIVE_HANDOVERS}</p>
        </td>
        <td width="50%" style="background:rgba(0,204,255,0.07);border:1px solid rgba(0,204,255,0.28);border-radius:12px;padding:14px">
          <p style="margin:0 0 4px;font-size:10px;letter-spacing:1.4px;text-transform:uppercase;color:#a9b6cc">Staff Commissions</p>
          <p style="margin:0;font-size:24px;font-weight:800;color:#00ccff">${values.STAFF_COMMISSIONS}</p>
        </td>
      </tr>
    </table>
    <p style="margin:0 0 8px;font-size:10px;letter-spacing:1.4px;text-transform:uppercase;color:#a9b6cc">Reconciliation Status</p>
    <p style="margin:0 0 18px;font-size:15px;font-weight:800;color:${values.RECON_COLOR}">${values.RECONCILIATION_STATUS}</p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px">
      <thead><tr style="background:rgba(0,204,255,0.10)">
        <th align="left" style="padding:8px;color:#a9b6cc">Staff</th>
        <th align="right" style="padding:8px;color:#a9b6cc">Sales</th>
        <th align="right" style="padding:8px;color:#a9b6cc">Gross</th>
        <th align="right" style="padding:8px;color:#a9b6cc">Comm.</th>
      </tr></thead>
      <tbody>${values.STAFF_ROWS}</tbody>
    </table>`;
  return buildEmailShell(`Month-End Report — ${vars.periodLabel}`, body);
}

/** One `<tr>` per staff member for the email table. */
export function buildStaffRowsHtml(summary: MonthEndSummary): string {
  if (summary.staffCommissions.length === 0) {
    return '<tr><td colspan="4" style="padding:12px;text-align:center;color:#66768f">No commission rows configured.</td></tr>';
  }
  return summary.staffCommissions
    .map((line, index) => {
      const bg = index % 2 === 0 ? 'rgba(255,255,255,0.02)' : 'transparent';
      return `<tr style="background:${bg}">
        <td align="left" style="padding:8px 10px;color:#e2e8f0;border-bottom:1px solid rgba(255,255,255,0.06)">${escapeHtml(line.staffName)}</td>
        <td align="right" style="padding:8px 10px;color:#8ea0bb;border-bottom:1px solid rgba(255,255,255,0.06)">${line.salesCount}</td>
        <td align="right" style="padding:8px 10px;color:#e2e8f0;border-bottom:1px solid rgba(255,255,255,0.06)">${escapeHtml(money(line.gross, summary.currency))}</td>
        <td align="right" style="padding:8px 10px;color:#ffcc00;font-weight:700;border-bottom:1px solid rgba(255,255,255,0.06)">${escapeHtml(money(line.commissionDue, summary.currency))}</td>
      </tr>`;
    })
    .join('');
}

/** Build the final HTML for a month-end summary. */
export function buildMonthEndEmailHtml(summary: MonthEndSummary): string {
  const baseUrl = process.env.BASE_URL || 'https://preyone.com';
  return renderMonthEndHtml({
    periodLabel: summary.period.label,
    totalRevenue: money(summary.totalRevenue, summary.currency),
    salesCount: summary.salesCount,
    activeHandovers: summary.activeHandovers,
    activeHandoverValue: money(summary.activeHandoverValue, summary.currency),
    staffCommissions: money(summary.staffCommissionTotal, summary.currency),
    reconciliationStatus: summary.reconciliationStatus,
    reconciliationDifference: money(Math.abs(summary.reconciliationDifference), summary.currency),
    reconciledValue: money(summary.reconciledValue, summary.currency),
    approvedHandoverValue: money(summary.approvedHandoverValue, summary.currency),
    staffRowsHtml: buildStaffRowsHtml(summary),
    logoUrl: `${baseUrl}/images/preyone-logo-mainInverse.png`,
  });
}

export interface MonthEndEmailResult {
  sent: boolean;
  recipients: string[];
  subject: string;
  attachmentName: string;
  reason?: string;
}

/**
 * Send the Month-End report with the Excel ledger attached.
 * Never throws — the scheduler logs and retries on the next tick.
 */
export async function sendMonthEndReportEmail(opts: {
  recipients: string[];
  summary: MonthEndSummary;
  attachment: Buffer;
  attachmentName?: string;
  extraRows?: SalesReportRow[];
}): Promise<MonthEndEmailResult> {
  const recipients = opts.recipients.map((r) => String(r || '').trim()).filter(Boolean);
  const subject = `Preyone Month-End Report — ${opts.summary.period.label}`;
  const attachmentName = opts.attachmentName || `preyone-month-end-${opts.summary.period.from.toISOString().slice(0, 7)}.xlsx`;

  if (recipients.length === 0) {
    return { sent: false, recipients, subject, attachmentName, reason: 'no_recipients' };
  }

  const html = buildMonthEndEmailHtml(opts.summary);
  const sent = await sendTransactionalEmail({
    to: recipients,
    subject,
    html,
    fromName: 'Preyone UltraNet',
    fromEmail: 'admin@preyone.com',
    attachments: [{ filename: attachmentName, content: opts.attachment }],
  });

  return {
    sent,
    recipients,
    subject,
    attachmentName,
    reason: sent ? undefined : 'smtp_unavailable_or_rejected',
  };
}
