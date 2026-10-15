import type { ReactElement } from 'react';
import {
  FaCamera,
  FaClock,
  FaDesktop,
  FaHeadphones,
  FaLaptop,
  FaMicrochip,
  FaMobileScreen,
  FaPrint,
  FaTabletScreenButton,
  FaTv,
} from 'react-icons/fa6';
import { TbRouter } from 'react-icons/tb';
import {
  SiApple,
  SiAsus,
  SiDell,
  SiGoogle,
  SiHp,
  SiHuawei,
  SiHonor,
  SiLg,
  SiLenovo,
  SiMotorola,
  SiNokia,
  SiOneplus,
  SiOppo,
  SiSamsung,
  SiSony,
  SiVivo,
  SiXiaomi,
} from 'react-icons/si';

/**
 * Intelligent device iconography for the client monitor.
 *
 * Ruijie's live feed gives us `staModel` ("SM-A536B"), `staManufacturer`
 * ("Samsung") and `staLabelName` ("Smartphone"); the historical audit trail
 * gives us a `users.user_agent` / `voucher_devices.label` string instead. Both
 * are scored against the same brand table first (so an iPhone renders the
 * Apple mark, not a generic handset) and then against a device-kind table, with
 * a neutral chip glyph as the last resort.
 */

export type DeviceKind =
  | 'phone'
  | 'tablet'
  | 'watch'
  | 'laptop'
  | 'desktop'
  | 'tv'
  | 'camera'
  | 'printer'
  | 'earbuds'
  | 'router'
  | 'generic';

const KIND_ICONS: Record<DeviceKind, typeof FaMobileScreen> = {
  phone: FaMobileScreen,
  tablet: FaTabletScreenButton,
  watch: FaClock,
  laptop: FaLaptop,
  desktop: FaDesktop,
  tv: FaTv,
  camera: FaCamera,
  printer: FaPrint,
  earbuds: FaHeadphones,
  router: TbRouter,
  generic: FaMicrochip,
};

/** Brand marks react-icons actually ships — matched as loose word aliases. */
const BRANDS: { brand: string; icon: typeof SiApple; match: RegExp; kind: DeviceKind }[] = [
  { brand: 'apple', icon: SiApple, match: /\b(apple|iphone|ipad|ipod|macbook|imac|airpods)\b/, kind: 'phone' },
  { brand: 'samsung', icon: SiSamsung, match: /\b(samsung|galaxy)\b/, kind: 'phone' },
  { brand: 'xiaomi', icon: SiXiaomi, match: /\b(xiaomi|redmi|poco)\b/, kind: 'phone' },
  { brand: 'huawei', icon: SiHuawei, match: /\bhuawei\b/, kind: 'phone' },
  { brand: 'honor', icon: SiHonor, match: /\bhonor\b/, kind: 'phone' },
  { brand: 'google', icon: SiGoogle, match: /\b(google|pixel)\b/, kind: 'phone' },
  { brand: 'oneplus', icon: SiOneplus, match: /\boneplus\b/, kind: 'phone' },
  { brand: 'oppo', icon: SiOppo, match: /\boppo\b/, kind: 'phone' },
  { brand: 'vivo', icon: SiVivo, match: /\bvivo\b/, kind: 'phone' },
  { brand: 'sony', icon: SiSony, match: /\bsony\b/, kind: 'tv' },
  { brand: 'lg', icon: SiLg, match: /\b(lg|webos)\b/, kind: 'tv' },
  { brand: 'nokia', icon: SiNokia, match: /\bnokia\b/, kind: 'phone' },
  { brand: 'motorola', icon: SiMotorola, match: /\b(motorola|moto)\b/, kind: 'phone' },
  { brand: 'lenovo', icon: SiLenovo, match: /\blenovo\b/, kind: 'laptop' },
  { brand: 'asus', icon: SiAsus, match: /\b(asus|zenfone|rog)\b/, kind: 'laptop' },
  { brand: 'dell', icon: SiDell, match: /\bdell\b/, kind: 'desktop' },
  { brand: 'hp', icon: SiHp, match: /\b(hp|hewlett)\b/, kind: 'desktop' },
];

/** Device-shape aliases, most specific first. Matched after the brand table. */
const KINDS: { kind: DeviceKind; match: RegExp }[] = [
  { kind: 'tv', match: /\b(tv|television|smart ?tv|tv ?box|set ?top|roku|chromecast|bravia|webos)\b/ },
  { kind: 'camera', match: /\b(camera|cctv|nvr|dome|doorbell|hikvision|ezviz)\b/ },
  { kind: 'printer', match: /\b(printer|scanner|mfp|plotter)\b/ },
  { kind: 'router', match: /\b(router|access ?point|extender|repeater|gateway|switch)\b/ },
  { kind: 'watch', match: /\b(watch|wearable|smartband)\b/ },
  { kind: 'earbuds', match: /\b(airpod|earbud|buds|headphone|headset)\b/ },
  { kind: 'tablet', match: /\b(tablet|ipad|kindle|tab)\b/ },
  // No trailing \b on "mac ?book": Ruijie sends model strings like
  // "MacBookAir10,1" where the brand word runs straight into the model id.
  { kind: 'laptop', match: /laptop|notebook|mac ?book|chromebook/ },
  { kind: 'desktop', match: /\b(desktop|workstation|computer|imac|pc)\b/ },
  { kind: 'phone', match: /\b(phone|mobile|smartphone|iphone|handset|android)\b/ },
];

/**
 * Makers that ship several device shapes, matched only when nothing more
 * specific was found. Hisense is the live example: a Hisense TV is by far the
 * common client on this network, so an untyped "Hisense 55A6K" should render a
 * television rather than an anonymous chip.
 */
const MAKER_KINDS: { match: RegExp; kind: DeviceKind }[] = [
  { match: /\b(hisense|tcl|skyworth|tencent|mi ?box)\b/, kind: 'tv' },
];

export interface DeviceIdentity {
  brand: string | null;
  kind: DeviceKind;
}

const haystackOf = (...parts: (string | null | undefined)[]) =>
  parts
    .filter((p): p is string => !!p && String(p).trim() !== '')
    .join(' ')
    .toLowerCase();

/**
 * Resolve a device into a brand + shape. `type` may be Ruijie's `staLabelName`
 * ("Windows PC", "TV/TV Box") or a free-form historical label.
 */
export function detectDevice(
  model?: string | null,
  manufacturer?: string | null,
  type?: string | null
): DeviceIdentity {
  const hay = haystackOf(model, manufacturer, type);
  if (!hay) return { brand: null, kind: 'generic' };

  const brandHit = BRANDS.find((b) => b.match.test(hay));
  // An explicit shape always beats the brand default: "MacBook" is an Apple
  // laptop, not an Apple phone.
  const kindHit = KINDS.find((k) => k.match.test(hay))?.kind;
  const makerHit = MAKER_KINDS.find((k) => k.match.test(hay))?.kind;

  return {
    brand: brandHit?.brand ?? null,
    kind: kindHit ?? brandHit?.kind ?? makerHit ?? 'generic',
  };
}

/** Inline SVG/glyph element sized for the 26px `.wf-avatar` chip. */
export function getDeviceIcon(
  model?: string | null,
  manufacturer?: string | null,
  type?: string | null
): ReactElement {
  const { kind } = detectDevice(model, manufacturer, type);
  const Icon = KIND_ICONS[kind];
  return <Icon size={14} aria-hidden="true" focusable="false" />;
}
