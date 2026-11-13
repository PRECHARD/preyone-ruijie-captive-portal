import { useState, type FormEvent } from 'react'
import { ArrowRight, CheckCircle2, MessageCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Reveal } from '../components/Reveal'
import { SectionHeading } from '../components/SectionHeading'
import { usePageMeta } from '../hooks/usePageMeta'
import { useI18n } from '../lib/i18n'
import { PARTNER_TIERS } from '../lib/suite'

const PARTNER_EMAIL = 'support@preyone.com'

export function PartnersPage() {
  const [form, setForm] = useState({
    name: '',
    company: '',
    email: '',
    phone: '',
    tier: PARTNER_TIERS[0].name,
    message: '',
  })
  const { t } = useI18n()

  usePageMeta(
    'Partner Programme — Preyone 360',
    'Refer, resell or implement Preyone 360. Join the partner programme for referral fees, reseller pricing and certified implementation training.',
  )

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const subject = `Preyone 360 partner application — ${form.company || form.name || 'New partner'}`
    const body = [
      `Name: ${form.name}`,
      `Company: ${form.company}`,
      `Email: ${form.email}`,
      `Phone: ${form.phone}`,
      `Partner type: ${form.tier}`,
      '',
      form.message,
    ].join('\n')
    window.location.href = `mailto:${PARTNER_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  }

  const update = (key: keyof typeof form, value: string) => setForm((prev) => ({ ...prev, [key]: value }))

  return (
    <>
      <section className="relative pt-44 pb-8">
        <div className="container-site">
          <SectionHeading
            label={t('partners.label')}
            title={t('partners.title')}
            desc={t('partners.desc')}
          />
        </div>
      </section>

      <section className="relative py-12">
        <div className="container-site grid gap-6 lg:grid-cols-3">
          {PARTNER_TIERS.map((tier, i) => (
            <Reveal key={tier.name} delay={(i % 3) * 0.07} className="h-full">
              <article className="mesh-card glass flex h-full flex-col rounded-3xl p-8">
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-300">Track {i + 1}</p>
                <h3 className="font-display mt-2 text-3xl tracking-wide text-white">{tier.name}</h3>
                <p className="mt-2 text-sm font-semibold text-slate-200">{tier.tagline}</p>
                <p className="mt-3 text-xs leading-relaxed text-slate-500">{tier.desc}</p>
                <ul className="mt-6 grid flex-1 gap-3 border-t border-white/8 pt-6">
                  {tier.benefits.map((benefit) => (
                    <li key={benefit} className="flex items-center gap-2.5 text-sm text-slate-300">
                      <CheckCircle2 size={15} className="shrink-0 text-cyan-400" />
                      {benefit}
                    </li>
                  ))}
                </ul>
              </article>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="relative py-16">
        <div className="container-site grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-start">
          <Reveal>
            <div>
              <SectionHeading
                label="Apply"
                title="Tell us about you"
                desc="Send a short application and we will reply with the partner pack, commercial terms and next steps."
                align="left"
              />
              <div className="glass rounded-2xl p-5">
                <p className="text-sm font-bold text-white">Prefer to talk first?</p>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">
                  WhatsApp the team and mention “partner programme”.
                </p>
                <a
                  href="https://wa.me/263771327202?text=Hi%20Preyone%2C%20I%27m%20interested%20in%20the%20360%20partner%20programme."
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-4 inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-cyan-300 transition-colors hover:text-white"
                >
                  <MessageCircle size={15} />
                  Chat on WhatsApp
                </a>
              </div>
            </div>
          </Reveal>

          <Reveal delay={0.1}>
            <form onSubmit={submit} className="glass rounded-3xl p-7 sm:p-8">
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Your name</span>
                  <input
                    required
                    value={form.name}
                    onChange={(e) => update('name', e.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-400/50"
                    placeholder="Tarisai Moyo"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Company</span>
                  <input
                    required
                    value={form.company}
                    onChange={(e) => update('company', e.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-400/50"
                    placeholder="Moyo Consulting"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Email</span>
                  <input
                    required
                    type="email"
                    value={form.email}
                    onChange={(e) => update('email', e.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-400/50"
                    placeholder="you@company.co.zw"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Phone</span>
                  <input
                    value={form.phone}
                    onChange={(e) => update('phone', e.target.value)}
                    className="mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-400/50"
                    placeholder="+263 ..."
                  />
                </label>
              </div>

              <label className="mt-4 block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Partner type</span>
                <select
                  value={form.tier}
                  onChange={(e) => update('tier', e.target.value)}
                  className="mt-2 w-full rounded-xl border border-white/10 bg-[#0a1220] px-4 py-3 text-sm text-white outline-none transition-colors focus:border-cyan-400/50"
                >
                  {PARTNER_TIERS.map((tier) => (
                    <option key={tier.name} value={tier.name}>
                      {tier.name}
                    </option>
                  ))}
                </select>
              </label>

              <label className="mt-4 block">
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">What do you do?</span>
                <textarea
                  required
                  rows={4}
                  value={form.message}
                  onChange={(e) => update('message', e.target.value)}
                  className="mt-2 w-full resize-none rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white outline-none transition-colors placeholder:text-slate-600 focus:border-cyan-400/50"
                  placeholder="Tell us about your clients, region and the apps you would lead with."
                />
              </label>

              <button type="submit" className="btn-primary mt-6 inline-flex w-full items-center justify-center px-6 py-3.5 text-sm uppercase tracking-wide">
                Send application
                <ArrowRight size={16} />
              </button>
              <p className="mt-3 text-center text-[11px] text-slate-500">
                This opens your email app with the details filled in. Nothing is stored on this site.
              </p>
            </form>
          </Reveal>
        </div>
      </section>

      <section className="relative py-16">
        <div className="container-site">
          <Reveal>
            <div className="glass glow-cyan mx-auto flex max-w-4xl flex-col items-center justify-between gap-6 rounded-3xl px-8 py-10 text-center sm:flex-row sm:text-left">
              <div>
                <h3 className="font-display text-3xl tracking-wide text-white sm:text-4xl">
                  Not sure which track fits?
                </h3>
                <p className="mt-1 text-sm text-slate-400">
                  Tell us how you work today and we will point you at the right partnership.
                </p>
              </div>
              <Link to="/#contact" className="btn-primary shrink-0 px-7 py-3.5 text-sm uppercase tracking-wide">
                Talk to our team
                <ArrowRight size={16} />
              </Link>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  )
}
