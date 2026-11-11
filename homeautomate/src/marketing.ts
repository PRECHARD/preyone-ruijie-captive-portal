/**
 * Public marketing copy fetched from the Express marketing router.
 * The Home Automation SPA is static, so each page asks `/api/<slug>` for its
 * hero, cards, steps and CTA instead of shipping the copy in the bundle.
 */

import type { IconName } from './icons';

export interface MarketingStat {
  value: string;
  label: string;
  foot?: string;
}

export interface MarketingCard {
  icon: IconName;
  title: string;
  body: string;
  tag?: string;
}

export interface MarketingStep {
  number: string;
  title: string;
  body: string;
}

export interface MarketingCta {
  eyebrow?: string;
  title: string;
  body: string;
  label: string;
  href: string;
  secondaryLabel?: string;
  secondaryHref?: string;
}

export interface MarketingPageData {
  slug: string;
  eyebrow: string;
  title: string;
  lede: string;
  stats: MarketingStat[];
  cards: MarketingCard[];
  steps?: MarketingStep[];
  bullets?: string[];
  cta: MarketingCta;
}

export interface ContactChannel {
  icon: IconName;
  label: string;
  value: string;
  href?: string;
}

export interface ContactPageData {
  slug: string;
  eyebrow: string;
  title: string;
  lede: string;
  channels: ContactChannel[];
  details: Array<{ label: string; value: string }>;
  steps: MarketingStep[];
  cta: MarketingCta;
}

/** Paths that have a dedicated marketing page and a matching JSON endpoint. */
export const MARKETING_PATHS = [
  '/platform',
  '/scenes',
  '/security',
  '/solutions/lighting',
  '/solutions/climate',
  '/solutions/audio',
  '/how-it-works',
] as const;

export type MarketingPath = (typeof MARKETING_PATHS)[number];

export function isMarketingPath(path: string): path is MarketingPath {
  return (MARKETING_PATHS as readonly string[]).includes(path);
}

export async function fetchMarketingPage<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    signal,
    headers: { Accept: 'application/json' },
    credentials: 'include',
  });
  if (!response.ok) {
    throw new Error(`Content request failed (${response.status})`);
  }
  return (await response.json()) as T;
}
