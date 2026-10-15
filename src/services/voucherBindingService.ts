import { pool } from '../db/pool';

// ===========================================================================
// Shared MAC → voucher resolver.
//
// Why this exists: Ruijie reports clients by MAC, never by voucher code, so
// every consumer (session enrichment, accounting attribution, usage rollup)
// needs the same join. It was previously written twice — once in
// routes/ruijie.ts and once in services/ruijieService.ts — and both copies
// carried the same bug:
//
//   voucher_devices.mac_norm and users.mac_address store UPPERCASE 12-hex
//   (see deviceBinding.normalizeMac), but normalizeRuijieMac() returns
//   lowercase, so `mac_norm = ANY($1)` never matched the primary indexed
//   source. Measured live: lowercase lookup = 0 rows, uppercase = 1 row,
//   which is exactly why session PIN coverage sat at ~3% (only the lower()
//   -wrapped users fallback could ever hit).
//
// All key handling below is done ONCE, here, in `bindingMacKey()`.
// ===========================================================================

export type BindingSource =
  | 'voucher_devices'
  | 'voucher_redemptions'
  | 'wispr_profiles'
  | 'users'
  | 'ruijie_user_name';

export interface VoucherBinding {
  /** Lowercased voucher code, or null when nothing resolved. */
  code: string | null;
  holderName: string | null;
  holderPhone: string | null;
  source: BindingSource | null;
}

export const UNBOUND: Readonly<VoucherBinding> = Object.freeze({
  code: null,
  holderName: null,
  holderPhone: null,
  source: null,
});

/**
 * Canonical MAC key: 12 lowercase hex chars, or null when unusable.
 * Accepts any spelling Ruijie or Postgres may hand us — colon, dash, dot
 * (macaddr style `0cb5.27ed.fef4`), uppercase, or bare.
 */
export function bindingMacKey(raw: unknown): string | null {
  const hex = String(raw ?? '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  return /^[0-9A-F]{12}$/.test(hex) ? hex.toLowerCase() : null;
}

/** voucher_devices.mac_norm is stored UPPERCASE — keep that spelling for the indexed lookup. */
function macNormUpper(key: string): string {
  return key.toUpperCase();
}

/** regexp used inline for the macaddr-style columns (redemptions/users/wispr). */
const MAC_SQL = (col: string) => `lower(regexp_replace(${col}, '[^0-9a-fA-F]', '', 'g'))`;

/**
 * Cheap shape filter so obviously-not-a-code labels never reach the database.
 *
 * Codes are generated from a no-vowel/digit alphabet with no spaces
 * (routes/admin.ts `${slug}-${rand}`, payments.ts `CT-` + 8 chars, and 6-char
 * Ruijie mints) — so anything containing whitespace, or longer than any of
 * those shapes, is a device/person label and can be dropped outright. Passing
 * the filter only buys a lookup; `vouchers.code` is still the thing that
 * decides, so a false positive can never surface as a PIN.
 */
function looksLikeVoucherCode(raw: unknown): boolean {
  return /^[a-z0-9][a-z0-9-]{3,23}$/.test(String(raw ?? '').trim().toLowerCase());
}

interface CodeRow {
  code: string;
}

/**
 * Resolve a batch of client MACs to voucher codes.
 *
 * Source precedence (first hit wins):
 *   1. voucher_devices     — explicit per-device binding (indexed, authoritative)
 *   2. voucher_redemptions — MAC captured at redemption time
 *   3. wispr_profiles      — MAC captured on the live WISPr gateway session
 *   4. users               — profile MAC written at signup
 *
 * Returned keys are canonical (`bindingMacKey`). MACs that resolve to nothing
 * are simply absent from the map — callers fall back to `UNBOUND`.
 * A single failing query degrades that source only; the rest still answer.
 */
export async function resolveVoucherBindings(
  macs: Iterable<unknown>
): Promise<Map<string, VoucherBinding>> {
  const out = new Map<string, VoucherBinding>();
  const keys = [...new Set([...macs].map(bindingMacKey).filter((k): k is string => k !== null))];
  if (keys.length === 0) return out;

  const assign = (key: string, code: unknown, source: BindingSource) => {
    if (out.has(key)) return;
    const normalized = String(code ?? '').trim().toLowerCase();
    if (!normalized) return;
    out.set(key, { code: normalized, holderName: null, holderPhone: null, source });
  };

  // 1) voucher_devices — UPPERCASE mac_norm, uppercase keys keep the index usable.
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (mac_norm) mac_norm, voucher_code
         FROM voucher_devices
        WHERE is_active = TRUE AND mac_norm = ANY($1::text[])`,
      [keys.map(macNormUpper)]
    );
    for (const row of rows) {
      const key = bindingMacKey(row.mac_norm);
      if (key) assign(key, row.voucher_code, 'voucher_devices');
    }
  } catch (err) {
    console.error('[VoucherBinding] voucher_devices lookup failed:', err);
  }

  // 2) voucher_redemptions — macaddr-style (`0cb5.27ed.fef4`).
  const unresolved = keys.filter((k) => !out.has(k));
  if (unresolved.length > 0) {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (${MAC_SQL('mac_address')}) ${MAC_SQL('mac_address')} AS mac_key, voucher_code
           FROM voucher_redemptions
          WHERE ${MAC_SQL('mac_address')} = ANY($1::text[])`,
        [unresolved]
      );
      for (const row of rows) {
        const key = bindingMacKey(row.mac_key);
        if (key) assign(key, row.voucher_code, 'voucher_redemptions');
      }
    } catch (err) {
      console.error('[VoucherBinding] voucher_redemptions lookup failed:', err);
    }
  }

  // 3) wispr_profiles → users.voucher_code (wispr has no code column of its own).
  const stillUnresolved = keys.filter((k) => !out.has(k));
  if (stillUnresolved.length > 0) {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (k) k AS mac_key, voucher_code
           FROM (
             SELECT ${MAC_SQL('wp.mac_address')} AS k, u.voucher_code
               FROM wispr_profiles wp
               JOIN users u ON u.id = wp.user_id
              WHERE u.voucher_code IS NOT NULL
           ) AS w
          WHERE k = ANY($1::text[])`,
        [stillUnresolved]
      );
      for (const row of rows) {
        const key = bindingMacKey(row.mac_key);
        if (key) assign(key, row.voucher_code, 'wispr_profiles');
      }
    } catch (err) {
      console.error('[VoucherBinding] wispr_profiles lookup failed:', err);
    }
  }

  // 4) users — last resort.
  const lastResort = keys.filter((k) => !out.has(k));
  if (lastResort.length > 0) {
    try {
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (mac_key) mac_key, voucher_code
           FROM (
             SELECT ${MAC_SQL('mac_address')} AS mac_key, voucher_code
               FROM users
              WHERE voucher_code IS NOT NULL
           ) AS u
          WHERE mac_key = ANY($1::text[])`,
        [lastResort]
      );
      for (const row of rows) {
        const key = bindingMacKey(row.mac_key);
        if (key) assign(key, row.voucher_code, 'users');
      }
    } catch (err) {
      console.error('[VoucherBinding] users lookup failed:', err);
    }
  }

  await attachHolderDetails(out);
  return out;
}

/** Convenience wrapper for a single MAC. */
export async function resolveVoucherBinding(mac: unknown): Promise<VoucherBinding> {
  const key = bindingMacKey(mac);
  if (!key) return { ...UNBOUND };
  const map = await resolveVoucherBindings([key]);
  return map.get(key) ?? { ...UNBOUND };
}

/**
 * Holder details for every code already resolved in the map (mutates in place).
 * Never throws — a missing holder just leaves the name/phone null.
 */
async function attachHolderDetails(bindings: Map<string, VoucherBinding>): Promise<void> {
  const codes = [...new Set([...bindings.values()].map((b) => b.code).filter((c): c is string => !!c))];
  if (codes.length === 0) return;
  const holders = await loadHolders(codes);
  for (const binding of bindings.values()) {
    if (!binding.code) continue;
    const holder = holders.get(binding.code);
    if (holder) {
      binding.holderName = holder.name;
      binding.holderPhone = holder.phone;
    }
  }
}

/** Holder name/phone per (lowercased) voucher code. One query, never throws. */
export async function loadHolders(
  codes: Iterable<unknown>
): Promise<Map<string, { name: string | null; phone: string | null }>> {
  const wanted = [...new Set(
    [...codes].map((c) => String(c ?? '').trim().toLowerCase()).filter(Boolean)
  )];
  const out = new Map<string, { name: string | null; phone: string | null }>();
  if (wanted.length === 0) return out;
  try {
    const { rows } = await pool.query(
      `SELECT lower(code) AS code, holder_name, holder_phone
         FROM vouchers
        WHERE lower(code) = ANY($1::text[]) AND deleted_at IS NULL`,
      [wanted]
    );
    for (const row of rows) {
      out.set(String(row.code), { name: row.holder_name ?? null, phone: row.holder_phone ?? null });
    }
  } catch (err) {
    console.error('[VoucherBinding] holder lookup failed:', err);
  }
  return out;
}

/**
 * Strict contract: confirm a reported identifier really IS a voucher code
 * before it is ever shown as one.
 *
 * Ruijie's `userName` is a device/person label (live sample: "M2003J15SC-
 * 636333004", 15-18 chars with letters and spaces) — NOT a voucher PIN. This
 * returns the stored code only when it matches `vouchers.code` case-
 * insensitively, otherwise null so the UI can render an em-dash.
 */
export async function verifyVoucherCode(raw: unknown): Promise<string | null> {
  const map = await verifyVoucherCodes([raw]);
  const candidate = String(raw ?? '').trim().toLowerCase();
  return map.get(candidate) ?? null;
}

/**
 * Batch form — one query for a whole page of sessions.
 * Map key = the candidate as sent in (trimmed, lowercased); value = the code
 * actually stored on `vouchers` (also lowercased).
 */
export async function verifyVoucherCodes(
  candidates: Iterable<unknown>
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(
    [...candidates].map((c) => String(c ?? '').trim().toLowerCase()).filter(looksLikeVoucherCode)
  )];
  if (wanted.length === 0) return out;
  try {
    const { rows } = await pool.query<CodeRow>(
      `SELECT lower(code) AS code
         FROM vouchers
        WHERE lower(code) = ANY($1::text[]) AND deleted_at IS NULL`,
      [wanted]
    );
    for (const row of rows) {
      if (row.code) out.set(row.code, row.code);
    }
  } catch (err) {
    console.error('[VoucherBinding] code verification failed:', err);
  }
  return out;
}
