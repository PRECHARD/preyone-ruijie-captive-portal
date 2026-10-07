import type { LucideIcon } from 'lucide-react'
import {
  Bus,
  Cctv,
  Cloud,
  Code,
  Cpu,
  Globe,
  Headset,
  Laptop,
  Network,
  Router,
  SatelliteDish,
  ShieldCheck,
  ShoppingBag,
  Smartphone,
  Wifi,
} from 'lucide-react'

/* ── Navigation ─────────────────────────────────────────── */
export type NavLink = { label: string; to: string }

export const NAV_LINKS: NavLink[] = [
  { label: 'Home', to: '/' },
  { label: 'Starlink', to: '/#starlink' },
  { label: 'Hardware', to: '/#hardware' },
  { label: 'Services', to: '/services' },
  { label: 'Portfolio', to: '/portfolio' },
  { label: 'Contact', to: '/#contact' },
]

/* ── Stats ──────────────────────────────────────────────── */
export type Stat = { value: number; suffix: string; label: string }

export const HERO_STATS: Stat[] = [
  { value: 500, suffix: '+', label: 'Clients Served' },
  { value: 50, suffix: '+', label: 'Projects Delivered' },
  { value: 99, suffix: '.9%', label: 'Network Uptime' },
  { value: 4, suffix: '+', label: 'Cities Covered' },
]

/* ── Tech & Hardware Showcase ───────────────────────────── */
export type ProductCategory = 'Starlink' | 'Laptops' | 'Flagships' | 'Mobile' | 'Networking' | 'Surveillance'

export const PRODUCT_FILTERS: ProductCategory[] = [
  'Starlink',
  'Laptops',
  'Flagships',
  'Mobile',
  'Networking',
  'Surveillance',
]

export type Spec = { label: string; value: string; pct: number }

export type Product = {
  id: string
  name: string
  category: ProductCategory
  tagline: string
  price: string
  priceNote: string
  badge?: string
  featured?: boolean
  icon: LucideIcon
  specs: Spec[]
}

export const PRODUCTS: Product[] = [
  {
    id: 'starlink-mini',
    name: 'Starlink Mini Kit',
    category: 'Starlink',
    tagline: 'Portable satellite internet that travels with you. 100 Mbps in your backpack.',
    price: '$350',
    priceNote: 'one-time',
    badge: 'Most Popular',
    featured: true,
    icon: SatelliteDish,
    specs: [
      { label: 'Download', value: 'Up to 100 Mbps', pct: 82 },
      { label: 'Portability', value: '1.3 kg pack', pct: 95 },
      { label: 'Setup', value: 'Self-install in 5 min', pct: 90 },
    ],
  },
  {
    id: 'starlink-standard',
    name: 'Starlink Standard Kit',
    category: 'Starlink',
    tagline: 'Full-size residential dish with high-throughput antenna for homes & businesses.',
    price: '$480',
    priceNote: 'one-time',
    badge: 'Best Value',
    featured: true,
    icon: SatelliteDish,
    specs: [
      { label: 'Download', value: 'Up to 220 Mbps', pct: 95 },
      { label: 'Data', value: 'Unlimited', pct: 100 },
      { label: 'Durability', value: 'Weather-resistant', pct: 90 },
    ],
  },
  {
    id: 'vortex-16',
    name: 'Vortex 16 Gaming',
    category: 'Laptops',
    tagline: 'Flagship gaming laptop — RTX-class graphics, 165 Hz display, liquid-cooled chassis.',
    price: '$1,850',
    priceNote: 'from',
    badge: 'New Drop',
    featured: true,
    icon: Laptop,
    specs: [
      { label: 'GPU', value: 'RTX 50-series', pct: 96 },
      { label: 'Display', value: '16" 165 Hz 2.5K', pct: 92 },
      { label: 'Memory', value: '32 GB DDR5', pct: 88 },
    ],
  },
  {
    id: 'ultrabook-pro',
    name: 'UltraBook Pro 16',
    category: 'Flagships',
    tagline: 'Business flagship — 4K OLED touch, aerospace-grade build, 20-hour battery.',
    price: '$1,250',
    priceNote: 'from',
    icon: Cpu,
    specs: [
      { label: 'Display', value: '4K OLED touch', pct: 94 },
      { label: 'Battery', value: 'Up to 20 hrs', pct: 90 },
      { label: 'Storage', value: '2 TB NVMe', pct: 86 },
    ],
  },
  {
    id: 'aurora-one',
    name: 'Aurora One 5G',
    category: 'Flagships',
    tagline: 'Pocket flagship — 6.9" 120 Hz LTPO, 200 MP camera and all-day autonomy.',
    price: '$999',
    priceNote: 'from',
    badge: 'Hot',
    icon: Smartphone,
    specs: [
      { label: 'Display', value: '6.9" 120 Hz LTPO', pct: 95 },
      { label: 'Camera', value: '200 MP AI triple', pct: 92 },
      { label: 'Charging', value: '80 W fast charge', pct: 89 },
    ],
  },
  {
    id: 'nova-g6',
    name: 'Nova G6 Mobile',
    category: 'Mobile',
    tagline: 'Mid-range value beast — 8K video, stereo audio, rugged all-day build.',
    price: '$420',
    priceNote: 'from',
    icon: Smartphone,
    specs: [
      { label: 'Camera', value: '8K video', pct: 78 },
      { label: 'Battery', value: '6,800 mAh', pct: 90 },
      { label: 'Audio', value: 'Stereo AMP', pct: 72 },
    ],
  },
  {
    id: 'mesh-ax6000',
    name: 'MESH AX6000 Router',
    category: 'Networking',
    tagline: 'Wi-Fi 6 mesh system — whole-home coverage with tri-band backhaul.',
    price: '$180',
    priceNote: 'from',
    icon: Router,
    specs: [
      { label: 'Speed', value: '6 Gbps tri-band', pct: 93 },
      { label: 'Coverage', value: 'Up to 550 m²', pct: 88 },
      { label: 'Clients', value: '128 devices', pct: 80 },
    ],
  },
  {
    id: 'switch-24',
    name: 'EdgeSwitch 24',
    category: 'Networking',
    tagline: 'Enterprise 24-port managed switch with 10 G uplinks and PoE++.',
    price: '$890',
    priceNote: 'from',
    icon: Network,
    specs: [
      { label: 'Bandwidth', value: '240 Gbps', pct: 96 },
      { label: 'PoE', value: 'PoE++ 60 W/port', pct: 90 },
      { label: 'Layers', value: 'L2+/L3 static', pct: 84 },
    ],
  },
  {
    id: 'ptz-4k',
    name: '4K PTZ Sentinel',
    category: 'Surveillance',
    tagline: '30× optical zoom PTZ camera with PoE, night vision and AI tracking.',
    price: '$420',
    priceNote: 'from',
    icon: Cctv,
    specs: [
      { label: 'Resolution', value: '4K Ultra HD', pct: 95 },
      { label: 'Zoom', value: '30× optical', pct: 90 },
      { label: 'Night', value: '100 m IR', pct: 86 },
    ],
  },
  {
    id: 'nvr-16',
    name: 'NVR 16-Channel',
    category: 'Surveillance',
    tagline: '16-channel network recorder with AI analytics and RAID storage.',
    price: '$650',
    priceNote: 'from',
    icon: ShieldCheck,
    specs: [
      { label: 'Channels', value: '16 × 8MP', pct: 88 },
      { label: 'Storage', value: '20 TB RAID', pct: 92 },
      { label: 'Analytics', value: 'AI people/vehicle', pct: 80 },
    ],
  },
]

/* ── Services ───────────────────────────────────────────── */
export type Service = {
  icon: LucideIcon
  title: string
  desc: string
  features: string[]
  gradient: string
}

export const SERVICES: Service[] = [
  {
    icon: Wifi,
    title: 'Connectivity & Starlink',
    desc: 'Authorised Starlink reseller — satellite internet for homes, schools, farms and businesses anywhere in Zimbabwe.',
    features: ['Starlink kits & installation', 'Mesh & hotspot rollouts', 'Backup connectivity', 'Network monitoring'],
    gradient: 'from-cyan-500 to-fuchsia-500',
  },
  {
    icon: Laptop,
    title: 'Hardware Sales',
    desc: 'Gaming laptops, flagship devices, workstations and servers — sourced, configured and delivered with warranty.',
    features: ['Gaming & business laptops', 'Flagship smartphones', 'Enterprise servers', 'Peripherals & accessories'],
    gradient: 'from-violet-600 to-pink-500',
  },
  {
    icon: Network,
    title: 'Networking & Infrastructure',
    desc: 'Enterprise-grade LAN/WAN design, structured cabling, Wi-Fi 6 rollouts and hardened network security.',
    features: ['Campus networks', 'Fiber & structured cabling', 'Firewall & VPN', 'Centralised management'],
    gradient: 'from-cyan-500 to-violet-500',
  },
  {
    icon: Cctv,
    title: 'Surveillance & Security',
    desc: 'AI-powered CCTV, access control and monitoring rooms — designed, installed and supported end-to-end.',
    features: ['4K AI cameras & NVRs', 'Access control', 'Remote monitoring', 'Maintenance plans'],
    gradient: 'from-fuchsia-500 to-violet-500',
  },
  {
    icon: Headset,
    title: 'Managed IT & Support',
    desc: 'Proactive IT support with SLAs, patching, backups and helpdesk so your teams stay productive.',
    features: ['Helpdesk with SLAs', 'Backups & disaster recovery', 'Cloud migration', 'Vendor management'],
    gradient: 'from-indigo-500 to-fuchsia-400',
  },
  {
    icon: Code,
    title: 'Software Development',
    desc: 'Web platforms, mobile apps, captive portals and enterprise systems engineered by a full-stack team.',
    features: ['Web apps & SPAs', 'Captive portals & RADIUS', 'Flutter mobile apps', 'APIs & integrations'],
    gradient: 'from-fuchsia-500 to-cyan-400',
  },
  {
    icon: Cloud,
    title: 'Cloud & DevOps',
    desc: 'Infrastructure automation, containers, CI/CD and cost-optimised hosting on trusted cloud providers.',
    features: ['Docker & Kubernetes', 'CI/CD pipelines', 'Cloud cost optimisation', '24/7 uptime monitoring'],
    gradient: 'from-violet-500 to-cyan-400',
  },
  {
    icon: Globe,
    title: 'IT Consulting',
    desc: 'Technology audits, digital transformation roadmaps and procurement advisory for growing organisations.',
    features: ['Technology audits', 'Digital roadmaps', 'Procurement advisory', 'Security reviews'],
    gradient: 'from-cyan-500 to-violet-500',
  },
]

/* ── Portfolio ──────────────────────────────────────────── */
export type Project = {
  name: string
  category: string
  description: string
  stack: string[]
  metrics: { label: string; value: number; suffix: string }[]
  link: string
  linkLabel: string
  year: string
  accent: string
  icon: LucideIcon
}

export const PROJECTS: Project[] = [
  {
    name: 'Preyone Transit',
    category: 'Mobility Platform',
    description:
      'Nationwide bus ticketing & fleet management platform — real-time seat booking, live GPS tracking and payment integration for transporters and passengers.',
    stack: ['Flutter', 'Node.js', 'PostgreSQL', 'Redis', 'WebSockets'],
    metrics: [
      { label: 'Riders', value: 24, suffix: 'k+' },
      { label: 'Trips tracked', value: 210, suffix: 'k+' },
      { label: 'Uptime', value: 99, suffix: '.9%' },
    ],
    link: '/portfolio#transit',
    linkLabel: 'View project',
    year: '2025',
    accent: 'from-cyan-500 to-fuchsia-500',
    icon: Bus,
  },
  {
    name: 'Preyone Captive Portal',
    category: 'WiFi Authentication',
    description:
      'Enterprise WiFi authentication for Ruijie gateways — voucher-based access, RADIUS integration and self-service account management for internet users.',
    stack: ['React', 'TypeScript', 'Node.js', 'FreeRADIUS', 'PostgreSQL'],
    metrics: [
      { label: 'Users online', value: 96, suffix: '' },
      { label: 'Redemptions', value: 12, suffix: 'k+' },
      { label: 'Uptime', value: 99, suffix: '.9%' },
    ],
    link: 'https://wifi.preyone.com',
    linkLabel: 'Live demo',
    year: '2024',
    accent: 'from-fuchsia-500 to-cyan-400',
    icon: Wifi,
  },
  {
    name: 'Preyone Admin Suite',
    category: 'Real-time Dashboard',
    description:
      'Real-time analytics and management console — voucher sales, revenue tracking, system health and role-based permissions for the whole network.',
    stack: ['React', 'Recharts', 'WebSocket', 'Redis', 'Node.js'],
    metrics: [
      { label: 'Metres', value: 32, suffix: 'k+' },
      { label: 'Dashboards', value: 14, suffix: '' },
      { label: 'Sessions', value: 98, suffix: '%' },
    ],
    link: 'https://admin.preyone.com',
    linkLabel: 'View suite',
    year: '2024',
    accent: 'from-indigo-500 to-fuchsia-400',
    icon: Cpu,
  },
  {
    name: 'Client Web Systems',
    category: 'Custom Builds',
    description:
      'Bespoke e-commerce, bookings and reservations platforms for Zimbabwean retailers and service businesses — built for scale and conversion.',
    stack: ['React', 'Stripe', 'MongoDB', 'Docker', 'Strapi'],
    metrics: [
      { label: 'Orders', value: 8, suffix: 'k+' },
      { label: 'Stores', value: 12, suffix: '' },
      { label: 'Growth', value: 40, suffix: '%' },
    ],
    link: '/portfolio#client-systems',
    linkLabel: 'Explore',
    year: '2023',
    accent: 'from-violet-500 to-pink-500',
    icon: ShoppingBag,
  },
]

export const TECH_MARQUEE = [
  'Starlink Satellite Internet',
  'Wi-Fi 6 Mesh',
  'Gaming Laptops',
  'Flagship Smartphones',
  '4K AI Surveillance',
  'Enterprise Networking',
  'Flutter Apps',
  'Captive Portals',
  'Cloud & DevOps',
]