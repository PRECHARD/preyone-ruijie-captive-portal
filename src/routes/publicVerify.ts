import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/pool';
import {
  documentVerifyUrl,
  normalizeDocumentVerifyCode,
} from '../utils/documentVerifyCode';

export const publicVerifyRouter = Router();

const verifyLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { valid: false, error: 'Too many verification requests. Try again in a minute.' },
});

interface VerifyRecord {
  doc_number: string;
  doc_type: string;
  issue_date: string;
  status: string;
  total: string | number;
  currency: string | null;
  created_at: string;
  verify_code: string;
  company_name: string | null;
  website: string | null;
  support_phone: string | null;
}

async function lookup(code: string): Promise<VerifyRecord | null> {
  const { rows } = await pool.query<VerifyRecord>(
    `SELECT d.doc_number, d.doc_type, to_char(d.issue_date, 'YYYY-MM-DD') AS issue_date,
            d.status, d.total, d.currency, d.created_at, d.verify_code,
            co.name AS company_name, co.website, co.support_phone
       FROM pos_documents d
       LEFT JOIN companies co ON co.id = d.company_id
      WHERE d.verify_code = $1
      LIMIT 1`,
    [code]
  );
  return rows[0] ?? null;
}

function dateOnly(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const raw = String(value ?? '');
  return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : raw;
}

function payload(code: string, record: VerifyRecord | null) {
  if (!record) {
    return {
      valid: false,
      code,
      reason: 'NOT_FOUND',
      message: 'No Preyone document matches this identifier.',
    };
  }
  return {
    valid: record.status !== 'void',
    code: record.verify_code,
    reason: record.status === 'void' ? 'VOIDED' : null,
    document: {
      number: record.doc_number,
      type: record.doc_type,
      issueDate: dateOnly(record.issue_date),
      status: record.status,
      total: Number(record.total) || 0,
      currency: record.currency || 'USD',
      issuedAt: record.created_at,
      company: record.company_name || 'Preyone Enterprises',
    },
    verifyUrl: documentVerifyUrl(record.verify_code),
    checkedAt: new Date().toISOString(),
  };
}

publicVerifyRouter.get('/document/:code', verifyLimiter, async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  const code = normalizeDocumentVerifyCode(req.params.code);
  if (!code) {
    res.status(422).json({
      valid: false,
      reason: 'INVALID_FORMAT',
      message: 'That is not a valid Preyone document identifier.',
    });
    return;
  }
  try {
    const record = await lookup(code);
    if (!record) {
      res.status(404).json(payload(code, null));
      return;
    }
    res.json(payload(code, record));
  } catch (err) {
    console.error('Document verification failed:', err);
    res.status(503).json({ valid: false, reason: 'UNAVAILABLE', message: 'Verification is temporarily unavailable.' });
  }
});

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pageShell(inner: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verify a Preyone document</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; padding: 28px 16px;
    font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
    color: #f5f0ff;
    background:
      radial-gradient(900px 500px at 12% -10%, rgba(124,58,237,.28), transparent 65%),
      radial-gradient(800px 460px at 105% 8%, rgba(217,70,239,.18), transparent 60%),
      #0c0618;
    display: grid; place-items: center;
  }
  .card {
    width: min(620px, 100%);
    border-radius: 22px;
    border: 1px solid rgba(168,85,247,.32);
    background: linear-gradient(160deg, rgba(28,15,50,.94), rgba(13,7,31,.96));
    box-shadow: 0 30px 90px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
    overflow: hidden;
  }
  .head {
    padding: 26px 28px 22px;
    border-bottom: 1px solid rgba(168,85,247,.18);
    background: linear-gradient(100deg, #14002e, #7a0e57 70%, #b4147f);
  }
  .brand { font-size: 11px; letter-spacing: .22em; text-transform: uppercase; opacity: .78; }
  h1 { margin: 8px 0 0; font-size: 24px; letter-spacing: -.02em; }
  .body { padding: 26px 28px 30px; }
  .state {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 7px 12px; border-radius: 999px;
    font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  }
  .state.ok { color: #8af7c7; border: 1px solid rgba(52,211,153,.45); background: rgba(16,185,129,.12); }
  .state.bad { color: #ff9fb0; border: 1px solid rgba(244,63,94,.45); background: rgba(244,63,94,.12); }
  .code {
    margin: 18px 0 6px; font-family: ui-monospace, Consolas, monospace;
    font-size: 17px; font-weight: 700; letter-spacing: .08em; color: #e9dcff;
    word-break: break-all;
  }
  .hint { color: #a79bc4; font-size: 13px; line-height: 1.55; }
  dl { display: grid; grid-template-columns: 120px 1fr; gap: 10px 14px; margin: 22px 0 0; font-size: 14px; }
  dt { color: #a79bc4; }
  dd { margin: 0; font-weight: 600; }
  .total { font-size: 30px; font-weight: 800; color: #fff; margin-top: 20px; }
  .foot { padding: 16px 28px 22px; border-top: 1px solid rgba(168,85,247,.18); color: #7d7297; font-size: 11px; }
  .foot a { color: #c9a7ff; text-decoration: none; }
  @media (max-width: 480px) { dl { grid-template-columns: 96px 1fr; } h1 { font-size: 21px; } }
</style>
</head>
<body><main class="card">${inner}</main></body>
</html>`;
}

export async function renderDocumentVerifyPage(req: Request, res: Response): Promise<void> {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  const code = normalizeDocumentVerifyCode(req.params.code);
  if (!code) {
    res.status(422).type('html').send(pageShell(`
      <header class="head"><div class="brand">Preyone Enterprises</div><h1>Document verification</h1></header>
      <div class="body">
        <span class="state bad">Invalid identifier</span>
        <p class="hint">That does not look like a Preyone document identifier. Check the <strong>Document ID</strong> printed in the bottom-left of the document.</p>
      </div>
      <footer class="foot">Need help? <a href="mailto:support@preyone.com">support@preyone.com</a></footer>
    `));
    return;
  }

  let record: VerifyRecord | null = null;
  try {
    record = await lookup(code);
  } catch (err) {
    console.error('Document verification page failed:', err);
  }

  if (!record) {
    res.status(404).type('html').send(pageShell(`
      <header class="head"><div class="brand">Preyone Enterprises</div><h1>Document verification</h1></header>
      <div class="body">
        <span class="state bad">Not found</span>
        <div class="code">${esc(code)}</div>
        <p class="hint">No Preyone document matches this identifier. It may have been mistyped, or it does not belong to a Preyone record.</p>
      </div>
      <footer class="foot">Need help? <a href="mailto:support@preyone.com">support@preyone.com</a></footer>
    `));
    return;
  }

  const voided = record.status === 'void';
  const total = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: record.currency || 'USD',
    minimumFractionDigits: 2,
  }).format(Number(record.total) || 0);

  res.type('html').send(pageShell(`
    <header class="head">
      <div class="brand">Preyone Enterprises · Official document check</div>
      <h1>${voided ? 'Document voided' : 'Document verified'}</h1>
    </header>
    <div class="body">
      <span class="state ${voided ? 'bad' : 'ok'}">${voided ? 'Voided record' : 'Authentic record'}</span>
      <div class="code">${esc(record.verify_code)}</div>
      <p class="hint">This identifier is stored against an issued Preyone document and cannot be reused.</p>
      <dl>
        <dt>Document</dt><dd>${esc(record.doc_number)}</dd>
        <dt>Type</dt><dd>${esc(record.doc_type.replace(/_/g, ' '))}</dd>
        <dt>Issued</dt><dd>${esc(dateOnly(record.issue_date))}</dd>
        <dt>Status</dt><dd>${esc(record.status)}</dd>
        <dt>Company</dt><dd>${esc(record.company_name || 'Preyone Enterprises')}</dd>
      </dl>
      <div class="total">${esc(total)}</div>
    </div>
    <footer class="foot">
      Verified by Preyone Enterprises · ${esc(new Date().toISOString().slice(0, 10))}<br>
      <a href="${esc(documentVerifyUrl(record.verify_code))}">${esc(documentVerifyUrl(record.verify_code))}</a>
    </footer>
  `));
}
