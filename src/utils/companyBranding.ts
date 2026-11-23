/**
 * Single server-side branding resolver.
 *
 * Every document, PDF and receipt surface should read the same resolved
 * branding instead of inventing its own fallbacks. The source of truth remains
 * the `companies` row plus `invoice_settings.branding` (tax/registration) and
 * `invoice_settings.receipt` (receipt overrides).
 */
export interface ResolvedCompanyBranding {
  name: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  logoUrl: string | null;
  logoPath: string | null;
  taxId: string;
  registrationNumber: string;
  termsText: string;
  footerText: string;
  receipt: Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveCompanyBranding(row: Record<string, unknown> | null | undefined): ResolvedCompanyBranding {
  const company = row ?? {};
  const settings = objectValue(company.invoice_settings);
  const receipt = objectValue(settings.receipt);
  const branding = objectValue(settings.branding);
  const logoPath = textValue(company.logo_path) || null;
  const logoUrl = textValue(company.logo_url) || (logoPath ? `/images/${logoPath}` : null);
  const footerText =
    textValue(receipt.footerNote) ||
    textValue(company.receipt_footer) ||
    '';

  return {
    name: textValue(company.name),
    tagline: textValue(company.tagline),
    address: textValue(company.address),
    phone: textValue(company.support_phone),
    email: textValue(company.email),
    website: textValue(company.website),
    logoUrl,
    logoPath,
    taxId: textValue(branding.taxId),
    registrationNumber: textValue(branding.registrationNumber),
    termsText: textValue(company.terms_text),
    footerText,
    receipt,
  };
}

export function withCompanyBranding<T extends Record<string, unknown>>(row: T) {
  return { ...row, branding: resolveCompanyBranding(row) };
}
