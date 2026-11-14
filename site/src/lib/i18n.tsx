import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'

export type Lang = 'en' | 'sn' | 'nd'

type Dict = Record<string, string>

const EN: Dict = {
  'nav.home': 'Home',
  'nav.starlink': 'Starlink',
  'nav.portal': 'Starlink Portal',
  'nav.hardware': 'Hardware',
  'nav.services': 'Services',
  'nav.apps': 'Business Apps',
  'nav.homeAutomate': 'Home Automate',
  'nav.portfolio': 'Portfolio',
  'nav.pay': 'Pay Invoice',
  'nav.contact': 'Contact',
  'cta.getConnected': 'Get Connected',
  'cta.demo': 'Book a 20-minute demo',
  'cta.explore': 'Explore the apps',
  'suite.label': 'Preyone 360',
  'suite.title': 'One suite. Every part of your business.',
  'suite.desc':
    'Start with the app you need. Add POS, invoicing, Wi-Fi, transit, home automation and more — one login, one shared record, priced app by app.',
  'pricing.label': 'Pricing',
  'pricing.title': 'Priced app by app',
  'pricing.desc':
    'Start with the one app you need today. Add more when the workflow calls for it — no forced bundle and no setup fees.',
  'partners.label': 'Partner programme',
  'partners.title': 'Grow with Preyone 360',
  'partners.desc':
    'Introduce clients, resell the suite or implement it on the ground. Pick the track that fits how you already work.',
}

const SN: Dict = {
  'nav.home': 'Kumba',
  'nav.starlink': 'Starlink',
  'nav.portal': 'Portal yeStarlink',
  'nav.hardware': 'Hardware',
  'nav.services': 'Mabasa',
  'nav.apps': 'Mabasa eBhizinesi',
  'nav.homeAutomate': 'Home Automate',
  'nav.portfolio': 'Mabasa Atakaita',
  'nav.pay': 'Bhadhara Invoice',
  'nav.contact': 'Taura Nesu',
  'cta.getConnected': 'Batanidzai',
  'cta.demo': 'Buka demo',
  'cta.explore': 'Ona mabasa',
  'suite.label': 'Preyone 360',
  'suite.title': 'Suite imwe. Zvikamu zvose zvebhizinesi rako.',
  'suite.desc':
    'Tanga neapp yaunoda. Wedzera POS, invoice, Wi-Fi, transit, home automation nezvimwe — login imwe, rekodhi imwe, mutengo weapp imwe neimwe.',
  'pricing.label': 'Mitengo',
  'pricing.title': 'Mutengo weapp imwe neimwe',
  'pricing.desc':
    'Tanga neapp imwe yaunoda nhasi. Wedzera dzimwe kana mashandiro achida — hapana bundle inomanikidzwa uye hapana mari yekutanga.',
  'partners.label': 'Chirongwa chevabatsiri',
  'partners.title': 'Kura naPreyone 360',
  'partners.desc':
    'Unza vatengi, tengesa suite kana kuivaka panzvimbo. Sarudza nzira inoenderana nemashandiro ako.',
}

const ND: Dict = {
  'nav.home': 'Ekhaya',
  'nav.starlink': 'Starlink',
  'nav.portal': 'Iphothali yeStarlink',
  'nav.hardware': 'Hardware',
  'nav.services': 'Imisebenzi',
  'nav.apps': 'Amapp ebhizinisi',
  'nav.homeAutomate': 'Home Automate',
  'nav.portfolio': 'Imisebenzi esiyenzileyo',
  'nav.pay': 'Khokha i-invoice',
  'nav.contact': 'Xhumana nathi',
  'cta.getConnected': 'Xhumanani',
  'cta.demo': 'Buka idemo',
  'cta.explore': 'Bona amapp',
  'suite.label': 'Preyone 360',
  'suite.title': 'Isuite eyodwa. Zonke izingxenye zebhizinisi lakho.',
  'suite.desc':
    'Qala ngeapp oyidingayo. Faka i-POS, i-invoice, i-Wi-Fi, i-transit, i-home automation nokunye — ukungena okukodwa, irekhodi elilodwa, intengo ngeapp ngayinye.',
  'pricing.label': 'Intengo',
  'pricing.title': 'Intengo ngeapp ngayinye',
  'pricing.desc':
    'Qala ngeapp eyodwa oyidingayo namuhla. Faka ezinye lapho umsebenzi udinga — akukho bundle ephoqayo futhi akukho mali yokuqala.',
  'partners.label': 'Uhlelo lwabambisani',
  'partners.title': 'Khula nePreyone 360',
  'partners.desc':
    'Letha amakhasimende, thengisa isuite noma uyisebenzise endaweni. Khetha indlela ehambisana nendlela osebenza ngayo.',
}

// First-pass Shona/Ndebele copy. Have a native speaker review before a public launch.
const DICTS: Record<Lang, Dict> = { en: EN, sn: SN, nd: ND }

const STORAGE_KEY = 'preyone_lang'

type I18nValue = {
  lang: Lang
  setLang: (lang: Lang) => void
  t: (key: string) => string
}

const I18nContext = createContext<I18nValue | null>(null)

function readStoredLang(): Lang {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'sn' || value === 'nd' || value === 'en' ? value : 'en'
  } catch {
    return 'en'
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStoredLang)

  const setLang = (next: Lang) => {
    setLangState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // ignore storage failures (private mode)
    }
  }

  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const value = useMemo<I18nValue>(
    () => ({
      lang,
      setLang,
      t: (key: string) => DICTS[lang][key] ?? EN[key] ?? key,
    }),
    [lang],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider')
  return ctx
}

export const LANGUAGES: { code: Lang; label: string; name: string }[] = [
  { code: 'en', label: 'EN', name: 'English' },
  { code: 'sn', label: 'SN', name: 'Shona' },
  { code: 'nd', label: 'ND', name: 'Ndebele' },
]
