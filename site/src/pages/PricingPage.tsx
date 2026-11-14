import { useState } from 'react'
import { ArrowRight, CheckCircle2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Reveal } from '../components/Reveal'
import { SectionHeading } from '../components/SectionHeading'
import { TrustBand } from '../components/TrustBand'
import { usePageMeta } from '../hooks/usePageMeta'
import { useI18n } from '../lib/i18n'
import { PRICING_FAQ, PRICING_PLANS, PRICING_POINTS } from '../lib/suite'

export function PricingPage() {
  const [yearly, setYearly] = useState(false)
  const { t } = useI18n()

  usePageMeta(
    'Pricing — Preyone 360 | Priced app by app',
    'Preyone 360 pricing: start with one app, add more as you grow. Monthly or yearly, no setup fees, one login across every app.',
  )

  return (
    <>
      <section className="relative pt-44 pb-8">
        <div className="container-site">
          <SectionHeading
            label={t('pricing.label')}
            title={t('pricing.title')}
            desc={t('pricing.desc')}
          />

          <Reveal delay={0.1}>
            <div className="mx-auto flex w-fit items-center gap-1 rounded-full border border-white/10 bg-white/5 p-1">
              <button
                type="button"
                onClick={() => setYearly(false)}
                className={`rounded-full px-5 py-2 text-xs font-bold uppercase tracking-widest transition-colors ${
                  yearly ? 'text-slate-400 hover:text-white' : 'bg-white/10 text-white'
                }`}
              >
                Monthly
              </button>
              <button
                type="button"
                onClick={() => setYearly(true)}
                className={`rounded-full px-5 py-2 text-xs font-bold uppercase tracking-widest transition-colors ${
                  yearly ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                Yearly
                <span className="ml-2 rounded-full bg-emerald-400/15 px-2 py-0.5 text-[9px] text-emerald-300">
                  2 months free
                </span>
              </button>
            </div>
            <p className="mt-3 text-center text-xs text-slate-500">
              {yearly ? 'Billed once a year. Two months free versus monthly.' : 'Billed every month. Cancel or change at the end of a cycle.'}
            </p>
          </Reveal>
        </div>
      </section>

      <section className="relative py-12">
        <div className="container-site grid gap-6 lg:grid-cols-3">
          {PRICING_PLANS.map((plan, i) => (
            <Reveal key={plan.name} delay={(i % 3) * 0.07} className="h-full">
              <article
                className={`mesh-card glass relative flex h-full flex-col rounded-3xl p-8 ${
                  plan.highlight ? 'border-cyan-400/30 shadow-[0_0_60px_rgba(34,211,238,0.08)]' : ''
                }`}
              >
                {plan.highlight && (
                  <span className="absolute -top-3 left-8 rounded-full border border-cyan-400/30 bg-[#0a1220] px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-cyan-300">
                    Most popular
                  </span>
                )}
                <h3 className="font-display text-3xl tracking-wide text-white">{plan.name}</h3>
                <p className="mt-1 text-sm text-slate-400">{plan.tagline}</p>
                <p className="mt-5 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                  Best for {plan.bestFor}
                </p>
                <p className="font-display mt-4 text-4xl leading-none text-white">
                  Request pricing
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  {yearly ? 'Yearly billing · 2 months free' : 'Monthly billing'}
                </p>

                <ul className="mt-7 grid flex-1 gap-3 border-t border-white/8 pt-6">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-2.5 text-sm text-slate-300">
                      <CheckCircle2 size={15} className="shrink-0 text-cyan-400" />
                      {feature}
                    </li>
                  ))}
                </ul>

                <Link
                  to="/#contact"
                  className={`mt-8 inline-flex items-center justify-center gap-2 rounded-xl px-6 py-3 text-sm font-bold uppercase tracking-wide ${
                    plan.highlight
                      ? 'btn-primary'
                      : 'glass text-slate-200 transition-colors hover:text-white'
                  }`}
                >
                  Talk to sales
                  <ArrowRight size={15} />
                </Link>
              </article>
            </Reveal>
          ))}
        </div>
      </section>

      <section className="relative py-16">
        <div className="container-site">
          <Reveal>
            <div className="glass rounded-3xl p-8 sm:p-10">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <span className="chip">The fine print, in plain English</span>
                  <h2 className="text-gradient font-display mt-3 text-4xl leading-none tracking-wide sm:text-5xl">
                    No surprises
                  </h2>
                </div>
                <Link
                  to="/#contact"
                  className="btn-primary shrink-0 px-7 py-3.5 text-sm uppercase tracking-wide"
                >
                  Request a quote
                  <ArrowRight size={16} />
                </Link>
              </div>
              <ul className="mt-8 grid gap-3 sm:grid-cols-2">
                {PRICING_POINTS.map((point) => (
                  <li key={point} className="flex items-center gap-2 text-sm text-slate-300">
                    <CheckCircle2 size={15} className="shrink-0 text-cyan-400" />
                    {point}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="relative py-16">
        <div className="container-site">
          <SectionHeading label="FAQ" title="Common questions" />
          <div className="mx-auto grid max-w-3xl gap-3">
            {PRICING_FAQ.map((item, i) => (
              <Reveal key={item.q} delay={(i % 5) * 0.04}>
                <details className="glass group rounded-2xl p-5">
                  <summary className="cursor-pointer list-none text-sm font-bold text-white marker:hidden">
                    <span className="flex items-center justify-between gap-4">
                      {item.q}
                      <span className="text-cyan-300 transition-transform group-open:rotate-45">+</span>
                    </span>
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-slate-400">{item.a}</p>
                </details>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <TrustBand />
    </>
  )
}
