export type ModuleKey = 'pos' | 'invoice';

export interface ModuleTile {
  key: ModuleKey;
  title: string;
  description: string;
  url: string;
}

export const MODULE_TILES: Record<ModuleKey, ModuleTile> = {
  pos: {
    key: 'pos',
    title: 'Preyone POS',
    description: 'Sales, shifts and stock.',
    url: 'https://pos.preyone.com',
  },
  invoice: {
    key: 'invoice',
    title: 'Invoice & Quotation',
    description: 'Invoices, quotations and PDF documents.',
    url: 'https://invoice.preyone.com',
  },
};

const ORDER: ModuleKey[] = ['pos', 'invoice'];

/** Tiles the signed-in company may open. Wi-Fi and admin are not desktop modules. */
export function tilesForModules(modules: readonly string[] | null | undefined): ModuleTile[] {
  const owned = new Set(modules ?? []);
  return ORDER.filter((key) => owned.has(key)).map((key) => MODULE_TILES[key]);
}

export function isModuleKey(value: string): value is ModuleKey {
  return value === 'pos' || value === 'invoice';
}

export function upgradeCopy(key: ModuleKey, planName: string | null): string {
  if (key === 'invoice') {
    const who = planName ? `${planName} does not include Invoice.` : 'Invoice is not on your plan.';
    return `${who} Upgrade to PreBiz or higher.`;
  }
  return 'POS is not on your plan.';
}
