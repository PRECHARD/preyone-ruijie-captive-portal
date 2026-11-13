import type { LucideIcon } from 'lucide-react'
import {
  Bus,
  FileText,
  FolderKanban,
  Home,
  LayoutDashboard,
  ShoppingBag,
  Users,
  Wifi,
} from 'lucide-react'

/* ── Preyone 360 suite ──────────────────────────────────── */

export type SuiteStatus = 'live' | 'roadmap'

export type SuiteDownload = {
  href: string
  label: string
  filename?: string
  platform?: string
}

export type SuiteProduct = {
  slug: string
  name: string
  category: string
  tagline: string
  desc: string
  icon: LucideIcon
  href: string
  external?: boolean
  download?: SuiteDownload
  status: SuiteStatus
  features: string[]
  whoFor: string[]
  worksWith: string[]
  gradient: string
}

export const SUITE_PRODUCTS: SuiteProduct[] = [
  {
    slug: 'pos360',
    name: 'POS360',
    category: 'Sales & Retail',
    tagline: 'Sell, track stock and print receipts from any till.',
    desc: 'A full point-of-sale for shops, bars and counters — quotations, stock control, thermal receipts and end-of-day X-reports.',
    icon: ShoppingBag,
    href: 'https://pos.preyone.com',
    external: true,
    status: 'live',
    features: ['Counter sales & quotations', 'Stock control', 'Thermal receipts & X-reports', 'Offline-capable tills'],
    whoFor: ['Shops & traders', 'Bars & restaurants', 'Pharmacies', 'Hardware stores'],
    worksWith: ['Invoice360', 'Console360', 'EcoCash', 'Thermal printers'],
    gradient: 'from-cyan-400 to-blue-500',
  },
  {
    slug: 'invoice360',
    name: 'Invoice360',
    category: 'Finance & Invoicing',
    tagline: 'Quotes, invoices, credit notes and AR aging in one place.',
    desc: 'Twelve document types, UBL export and receivables aging so your books stay tidy and your customers stay chased.',
    icon: FileText,
    href: 'https://invoice.preyone.com',
    external: true,
    status: 'live',
    features: ['12 document types', 'UBL export', 'AR aging', 'Multi-currency totals'],
    whoFor: ['SMEs', 'Consultants', 'Contractors', 'Finance teams'],
    worksWith: ['POS360', 'Console360', 'Pesepay', 'Bank transfer'],
    gradient: 'from-fuchsia-400 to-violet-500',
  },
  {
    slug: 'wifi360',
    name: 'WiFi360',
    category: 'Connectivity',
    tagline: 'Voucher Wi-Fi with RADIUS, captive portal and tenant control.',
    desc: 'Hotspot access that just works: voucher redemption, Ruijie gateway integration, bandwidth packages and a self-service portal.',
    icon: Wifi,
    href: 'https://wifi.preyone.com',
    external: true,
    status: 'live',
    features: ['Voucher redemption', 'Ruijie & FreeRADIUS', 'Bandwidth packages', 'Guest self-service'],
    whoFor: ['Hotspots', 'Lodges', 'Schools', 'Landlords'],
    worksWith: ['Ruijie', 'FreeRADIUS', 'POS360', 'Console360'],
    gradient: 'from-emerald-400 to-teal-500',
  },
  {
    slug: 'transit360',
    name: 'Transit360',
    category: 'Transport & Ticketing',
    tagline: 'Sell seats, issue tickets and reconcile the trip.',
    desc: 'Seat inventory, conductor tooling and printed tickets for bus and shuttle operators — built for low-connectivity routes.',
    icon: Bus,
    href: '/#contact',
    download: {
      href: '/downloads/app-release.apk',
      label: 'Download the app',
      filename: 'PreyoneTransit.apk',
      platform: 'Android',
    },
    status: 'live',
    features: ['Seat inventory', 'Conductor app', 'Ticket printing', 'Trip reconciliation'],
    whoFor: ['Bus operators', 'Shuttle services', 'Fleet owners'],
    worksWith: ['POS360', 'Invoice360', 'Thermal printers'],
    gradient: 'from-amber-400 to-orange-500',
  },
  {
    slug: 'home360',
    name: 'Home Automate',
    category: 'Home Automation & IoT',
    tagline: 'Devices, telemetry and triggers for homes and sites.',
    desc: 'A company-scoped IoT dashboard: register devices, stream telemetry, set threshold triggers and command equipment remotely.',
    icon: Home,
    href: 'https://homeautomate.preyone.com',
    external: true,
    status: 'live',
    features: ['Device registry', 'Live telemetry', 'Threshold triggers', 'Tenant-scoped access'],
    whoFor: ['Homeowners', 'Property managers', 'Sites & estates'],
    worksWith: ['MQTT bridges', 'HTTP devices', 'Console360'],
    gradient: 'from-sky-400 to-indigo-500',
  },
  {
    slug: 'console360',
    name: 'Console360',
    category: 'Business Console',
    tagline: 'One tenant-aware console for users, billing and settings.',
    desc: 'The control room behind every Preyone app: companies, roles, subscriptions, vouchers and global settings in one login.',
    icon: LayoutDashboard,
    href: 'https://admin.preyone.com',
    external: true,
    status: 'live',
    features: ['Multi-tenant', 'Roles & permissions', 'Billing & subscriptions', 'Global settings'],
    whoFor: ['Business owners', 'Operations managers', 'IT admins'],
    worksWith: ['All Preyone apps', 'Pesepay', 'ContiPay', 'Ruijie'],
    gradient: 'from-violet-400 to-purple-500',
  },
]

export const SUITE_ROADMAP: SuiteProduct[] = [
  {
    slug: 'crm360',
    name: 'CRM360',
    category: 'Sales & Support',
    tagline: 'Leads, pipeline and follow-ups that share the same data.',
    desc: 'Capture enquiries, track deals and keep every customer conversation attached to the invoice that follows.',
    icon: Users,
    href: '/#contact',
    status: 'roadmap',
    features: ['Lead inbox', 'Pipeline stages', 'Follow-up reminders', 'Shared customer record'],
    whoFor: ['Sales teams', 'Support teams', 'Founders'],
    worksWith: ['Invoice360', 'POS360', 'Console360'],
    gradient: 'from-slate-400 to-slate-500',
  },
  {
    slug: 'hr360',
    name: 'HR360',
    category: 'HR & Payroll',
    tagline: 'Staff records, leave and payroll in the same suite.',
    desc: 'Employee records, leave balances and payroll runs that feed straight into the finance side of the suite.',
    icon: Users,
    href: '/#contact',
    status: 'roadmap',
    features: ['Staff records', 'Leave balances', 'Payroll runs', 'Payslip exports'],
    whoFor: ['HR teams', 'Payroll officers', 'Growing SMEs'],
    worksWith: ['Invoice360', 'Console360'],
    gradient: 'from-slate-400 to-slate-500',
  },
  {
    slug: 'project360',
    name: 'Project360',
    category: 'Projects & Delivery',
    tagline: 'Budgets, milestones and stage invoicing for project work.',
    desc: 'Plan the job, track materials and services, and invoice each completed stage without re-keying anything.',
    icon: FolderKanban,
    href: '/#contact',
    status: 'roadmap',
    features: ['Budgets & milestones', 'Materials & services', 'Stage invoicing', 'Delivery tracking'],
    whoFor: ['Contractors', 'IT & engineering firms', 'Fit-out teams'],
    worksWith: ['Invoice360', 'CRM360', 'Console360'],
    gradient: 'from-slate-400 to-slate-500',
  },
]

export const ALL_SUITE_PRODUCTS = [...SUITE_PRODUCTS, ...SUITE_ROADMAP]

export function findSuiteProduct(slug: string): SuiteProduct | undefined {
  return ALL_SUITE_PRODUCTS.find((product) => product.slug === slug)
}

/* ── Illustrative lead-to-cash panel ────────────────────── */

export type SuiteMetric = {
  label: string
  value: number
  suffix?: string
  money?: boolean
  hint: string
}

export const LEAD_TO_CASH: SuiteMetric[] = [
  { label: 'Leads captured', value: 240, hint: 'This month' },
  { label: 'Qualified', value: 96, hint: '40% of leads' },
  { label: 'Deals won', value: 31, hint: '32% win rate' },
  { label: 'Invoiced', value: 130200, money: true, hint: 'This month' },
  { label: 'Collected', value: 112000, money: true, hint: '$18,200 outstanding' },
]

/* ── Suite stats ────────────────────────────────────────── */

export type SuiteStat = { value: number; suffix: string; label: string }

export const SUITE_STATS: SuiteStat[] = [
  { value: 6, suffix: '', label: 'Live apps' },
  { value: 500, suffix: '+', label: 'Clients served' },
  { value: 99, suffix: '.9%', label: 'Network uptime' },
  { value: 4, suffix: '+', label: 'Cities covered' },
]

/* ── Built for Zimbabwe ─────────────────────────────────── */

export type LocalFeature = { title: string; desc: string }

export const LOCAL_FEATURES: LocalFeature[] = [
  {
    title: 'Multi-currency by default',
    desc: 'Price and settle in USD or ZWG without a second system.',
  },
  {
    title: 'Local payments',
    desc: 'EcoCash, ZimSwitch, Visa and Mastercard alongside card and bank transfer.',
  },
  {
    title: 'Harare-based support',
    desc: 'Real people in your timezone for onboarding, training and fixes.',
  },
  {
    title: 'Local hosting & backups',
    desc: 'Your data stays in-region, with automated backups while you are subscribed.',
  },
]

/* ── Pricing ────────────────────────────────────────────── */

export type PricingPlan = {
  name: string
  tagline: string
  bestFor: string
  features: string[]
  highlight?: boolean
}

export const PRICING_PLANS: PricingPlan[] = [
  {
    name: 'Starter',
    tagline: 'One app to get moving.',
    bestFor: 'Sole traders & small shops',
    features: ['1 app of your choice', 'Up to 3 users', 'Email support', 'Monthly or yearly billing'],
  },
  {
    name: 'Growth',
    tagline: 'The day-to-day suite.',
    bestFor: 'Growing SMEs',
    highlight: true,
    features: [
      'Up to 3 apps',
      'Up to 15 users',
      'Priority support',
      'Guided onboarding',
      'Shared customer record',
    ],
  },
  {
    name: 'Enterprise',
    tagline: 'Everything, connected.',
    bestFor: 'Multi-branch & enterprise',
    features: [
      'All live apps',
      'Unlimited users',
      'Dedicated support & SLA',
      'Custom integrations',
      'Migration assistance',
    ],
  },
]

export const PRICING_POINTS = [
  'Start with one app and add more as you grow.',
  'Priced per app, monthly or yearly.',
  'One login across every app you subscribe to.',
  'No setup fees. Migration help included.',
]

export const PRICING_FAQ = [
  {
    q: 'Do I have to buy the whole suite?',
    a: 'No. Start with the one app you need today and add more when the workflow calls for it. Every app shares the same customer record, so nothing gets re-keyed.',
  },
  {
    q: 'Can I switch plans later?',
    a: 'Yes. Move up, down or sideways at the end of a billing cycle. Your data and users stay intact.',
  },
  {
    q: 'Is there a setup fee?',
    a: 'No setup fees. Onboarding, training and migration help are included in the subscription.',
  },
  {
    q: 'How does billing work?',
    a: 'Monthly or yearly, in USD or ZWG. Yearly billing gives you two months free. Pay by EcoCash, ZimSwitch, card or bank transfer.',
  },
  {
    q: 'Where is my data hosted?',
    a: 'In-region, on infrastructure we run ourselves. Automated backups run while your subscription is active.',
  },
]

/* ── Partner programme ──────────────────────────────────── */

export type PartnerTier = {
  name: string
  tagline: string
  desc: string
  benefits: string[]
}

export const PARTNER_TIERS: PartnerTier[] = [
  {
    name: 'Referral Partner',
    tagline: 'Introduce clients. Earn a referral fee.',
    desc: 'For accountants, consultants and agencies who meet businesses that need a better operating stack.',
    benefits: ['Referral commission', 'Sales collateral', 'Deal registration', 'Named contact'],
  },
  {
    name: 'Reseller Partner',
    tagline: 'Resell, bundle and support.',
    desc: 'For IT providers and service businesses that want to sell Preyone 360 under their own service wrap.',
    benefits: ['Reseller pricing', 'Demo environment', 'Priority support', 'Quarterly reviews'],
  },
  {
    name: 'Implementation Partner',
    tagline: 'Implement, integrate and train.',
    desc: 'For consultancies that configure, migrate and train customers on the suite.',
    benefits: ['Certified training', 'Implementation toolkit', 'Joint onboarding', 'Lead referrals'],
  },
]

/* ── Trust band ─────────────────────────────────────────── */

export type TrustPoint = { title: string; desc: string }

export const TRUST_POINTS: TrustPoint[] = [
  { title: '99.9% uptime target', desc: 'Run on infrastructure we own and monitor.' },
  { title: 'Harare-based support', desc: 'Real people in your timezone.' },
  { title: 'No setup fees', desc: 'Start with one app and grow.' },
  { title: 'Automated backups', desc: 'Included while you are subscribed.' },
]
