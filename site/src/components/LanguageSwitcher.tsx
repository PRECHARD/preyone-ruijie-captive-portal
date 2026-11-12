import { LANGUAGES, useI18n } from '../lib/i18n'

export function LanguageSwitcher() {
  const { lang, setLang } = useI18n()

  return (
    <div
      className="flex items-center gap-0.5 rounded-lg border border-white/10 bg-white/5 p-0.5"
      role="group"
      aria-label="Language"
    >
      {LANGUAGES.map((item) => (
        <button
          key={item.code}
          type="button"
          onClick={() => setLang(item.code)}
          title={item.name}
          aria-pressed={lang === item.code}
          className={`rounded-md px-2 py-1 text-[10px] font-bold tracking-widest transition-colors ${
            lang === item.code ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  )
}
