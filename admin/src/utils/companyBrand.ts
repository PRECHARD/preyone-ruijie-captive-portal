import { api } from '../api/client';

export interface CompanyBrand {
  name: string;
  tagline: string;
  address: string;
  email: string;
  support_phone: string;
  website: string;
  currency: string;
  tax_pct: number;
  receipt_footer: string;
}

export const BRAND_PALETTE = {
  DPB: 'FF2D1B69',
  NP: 'FFA855F7',
  LP: 'FFF3E8FF',
  RD: 'FFB91C1C',
  NV: 'FF000080',
  WH: 'FFFFFFFF',
};

export const DEFAULT_BRAND: CompanyBrand = {
  name: 'Preyone enterprise',
  tagline: '',
  address: '',
  email: 'info@preyone.com',
  support_phone: '+263 77 132 7202',
  website: 'www.preyone.com',
  currency: 'USD',
  tax_pct: 0,
  receipt_footer: '',
};

let cached: CompanyBrand | null = null;

export async function getCompanyBrand(): Promise<CompanyBrand> {
  if (cached) return cached;
  try {
    const c = await api.get<any>('/company');
    cached = {
      name: c?.name || DEFAULT_BRAND.name,
      tagline: c?.tagline || '',
      address: c?.address || '',
      email: c?.email || DEFAULT_BRAND.email,
      support_phone: c?.support_phone || DEFAULT_BRAND.support_phone,
      website: c?.website || DEFAULT_BRAND.website,
      currency: c?.currency || DEFAULT_BRAND.currency,
      tax_pct: Number(c?.tax_pct) || 0,
      receipt_footer: c?.receipt_footer || '',
    };
  } catch {
    cached = DEFAULT_BRAND;
  }
  return cached;
}

export function money(n: number, currency: string): string {
  const sym =
    currency === 'USD'
      ? '$'
      : currency === 'EUR'
        ? '€'
        : currency === 'GBP'
          ? '£'
          : currency === 'ZWL'
            ? 'ZWL '
            : `${currency} `;
  return `${sym}${(Number(n) || 0).toFixed(2)}`;
}