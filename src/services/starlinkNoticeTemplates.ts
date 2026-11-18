/**
 * Starlink customer portal — plan-switch notices (customer and admin).
 * Uses the shared layout from starlinkEmailTemplates so every Starlink email matches.
 */
import { layout, button, esc, firstName, starlinkBaseUrl } from './starlinkEmailTemplates';

const C = {
  text: '#e8edf6',
  mut: '#97a1b5',
  dim: '#64748b',
  cyan: '#00e5ff',
  panel: '#080a12',
  line: '#1e2435',
};
const FONT = "'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export interface NoticeInput {
  subject: string;
  preheader: string;
  eyebrow: string;
  heading: string;
  paragraphs: string[];
  facts?: Array<[string, string]>;
  cta?: { label: string; href: string };
  recipient: string;
}

export function buildNoticeEmail(input: NoticeInput): { subject: string; html: string; text: string } {
  const base = starlinkBaseUrl();
  const paragraphs = input.paragraphs
    .map((p) => `<p style="margin:0 0 14px;font:15px/1.7 ${FONT};color:${C.mut}">${p}</p>`)
    .join('');
  const facts = (input.facts ?? [])
    .map(
      ([k, v]) => `<tr>
                  <td style="padding:10px 0;border-bottom:1px solid ${C.line};font:12px ${FONT};letter-spacing:1px;text-transform:uppercase;color:${C.dim};width:44%">${esc(k)}</td>
                  <td style="padding:10px 0;border-bottom:1px solid ${C.line};font:600 14px ${FONT};color:${C.text}">${esc(v)}</td>
                </tr>`
    )
    .join('');
  const factsBlock = facts
    ? `<tr><td style="padding:6px 32px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.panel};border:1px solid ${C.line};border-radius:12px;padding:6px 16px">${facts}</table></td></tr>`
    : '';
  const cta = input.cta
    ? `<tr><td align="center" style="padding:6px 32px 22px">${button(esc(input.cta.href), esc(input.cta.label))}</td></tr>`
    : '';

  const body = `
          <tr><td style="padding:0 32px 14px">${paragraphs}</td></tr>
          ${factsBlock}
          ${cta}`;

  const html = layout({
    preheader: input.preheader,
    eyebrow: input.eyebrow,
    heading: esc(input.heading),
    body,
    recipient: input.recipient,
    base,
  });

  const textParas = input.paragraphs.map((p) => p.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&'));
  const textFacts = (input.facts ?? []).map(([k, v]) => `${k}: ${v}`);
  const text = [
    input.heading,
    '',
    ...textParas,
    '',
    ...textFacts,
    ...(input.cta ? ['', `${input.cta.label}: ${input.cta.href}`] : []),
    '',
    'Preyone Starlink Customer Portal · support@preyone.com · +263 771 327 202',
  ].join('\n');

  return { subject: input.subject, html, text };
}

export function planApplicationReceivedEmail(input: {
  fullName: string;
  email: string;
  planName: string;
  priceUsd: number;
  startDate: string;
}) {
  return buildNoticeEmail({
    subject: `We received your request to switch to ${input.planName}`,
    preheader: `Application received. Confirmation follows if there is capacity from ${input.startDate}.`,
    eyebrow: 'Plan switch',
    heading: 'Application received',
    paragraphs: [
      `Hi ${firstName(input.fullName)}, we have received your request to switch to the <strong style="color:${C.text}">${esc(input.planName)}</strong> package ($${input.priceUsd}/month).`,
      `Your current package stays active until <strong style="color:${C.cyan}">${esc(input.startDate)}</strong>.`,
      `You will receive a confirmation email if there is capacity for this package. If there is not, we will tell you and your current plan stays unchanged.`,
    ],
    facts: [
      ['Requested package', input.planName],
      ['Start date', input.startDate],
      ['Status', 'Under review'],
    ],
    cta: { label: 'View my plans', href: `${starlinkBaseUrl()}/starlink/portal` },
    recipient: input.email,
  });
}

export function planApplicationAdminEmail(input: {
  applicationId: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  fromPlan: string;
  toPlan: string;
  startDate: string;
}) {
  return buildNoticeEmail({
    subject: `New Starlink plan application: ${input.customerName} → ${input.toPlan}`,
    preheader: `${input.customerName} requested ${input.toPlan} from ${input.startDate}.`,
    eyebrow: 'Admin · Plan switch',
    heading: 'New plan application',
    paragraphs: [
      `A customer has applied to switch package. Review capacity in the admin console and approve or decline the request.`,
    ],
    facts: [
      ['Customer', input.customerName],
      ['Email', input.customerEmail],
      ['Phone', input.customerPhone],
      ['Current package', input.fromPlan],
      ['Requested package', input.toPlan],
      ['Start date', input.startDate],
      ['Reference', input.applicationId.slice(0, 8).toUpperCase()],
    ],
    cta: { label: 'Open Starlink admin', href: `${starlinkBaseUrl()}/` },
    recipient: 'Preyone admin',
  });
}

export function planApplicationApprovedEmail(input: { fullName: string; email: string; planName: string; startDate: string }) {
  return buildNoticeEmail({
    subject: `Confirmed: your switch to ${input.planName}`,
    preheader: `Your plan switch is confirmed from ${input.startDate}.`,
    eyebrow: 'Plan switch',
    heading: 'Your plan switch is confirmed',
    paragraphs: [
      `Hi ${firstName(input.fullName)}, there is capacity for the <strong style="color:${C.text}">${esc(input.planName)}</strong> package and your switch is confirmed from <strong style="color:${C.cyan}">${esc(input.startDate)}</strong>.`,
      `Your first invoice for the new package will appear in Billing before the start date.`,
    ],
    facts: [
      ['New package', input.planName],
      ['Effective from', input.startDate],
      ['Status', 'Confirmed'],
    ],
    cta: { label: 'Open my portal', href: `${starlinkBaseUrl()}/starlink/portal` },
    recipient: input.email,
  });
}

export function planApplicationRejectedEmail(input: { fullName: string; email: string; planName: string; note: string }) {
  return buildNoticeEmail({
    subject: `Update on your request to switch to ${input.planName}`,
    preheader: 'We could not confirm your plan switch right now.',
    eyebrow: 'Plan switch',
    heading: 'Plan switch not confirmed',
    paragraphs: [
      `Hi ${firstName(input.fullName)}, we could not confirm your switch to the <strong style="color:${C.text}">${esc(input.planName)}</strong> package at this time. Your current plan is unchanged.`,
      esc(input.note || 'Please contact support if you would like to discuss other options.'),
    ],
    cta: { label: 'Contact support', href: 'mailto:support@preyone.com' },
    recipient: input.email,
  });
}
