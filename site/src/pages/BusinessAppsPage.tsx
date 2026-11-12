import { ArrowRight, CheckCircle2, Download, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { CountUp } from '../components/CountUp'
import { Reveal } from '../components/Reveal'
import { SectionHeading } from '../components/SectionHeading'
import { TrustBand } from '../components/TrustBand'
import { usePageMeta } from '../hooks/usePageMeta'
import { useI18n } from '../lib/i18n'
import {
  LEAD_TO_CASH,
  LOCAL_FEATURES,
  PRICING_POINTS,
  SUITE_PRODUCTS,
  SUITE_ROADMAP,
  SUITE_STATS,
  type SuiteProduct,
} from '../lib/suite'

function ProductCard({ product, index }: { product: SuiteProduct; index: number }) {
  const Icon = product.icon
  const live = product.status === 'live'

  return (
    <Reveal delay={(index % 3) * 0.06} className="h-full">
      <article
        className={`mesh-card glass relative flex h-full flex-col overflow-hidden rounded-3xl p-7 transition-all duration-300 hover:-translate-y-1 hover:border-white/20 ${
          live ? '' : 'opacity-80'
        }`}
      >
        <div className="flex items-start justify-between gap-3">
          <div
            className={`inline-flex items-center justify-center rounded-2xl bg-gradient-to-br ${product.gradient} p-3 text-white shadow-lg`}
          >
            <Icon size={24} />
          </div>
          <span
            className={`rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest ${
              live
                ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
                : 'border-white/15 bg-white/5 text-slate-400'
            }`}
          >
            {live ? 'Live' : 'Roadmap'}
          </span>
        </div>

        <p className="mt-5 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-300">
          {product.category}
        </p>
        <h3 className="font-display text-3xl tracking-wide text-white">{product.name}</h3>
        <p className="mt-2 text-sm font-semibold leading-relaxed text-slate-200">{product.tagline}</p>
        <p className="mt-3 text-xs leading-relaxed text-slate-500">{product.desc}</p>

        <ul className="mt-5 grid flex-1 grid-cols-1 gap-2 border-t border-white/8 pt-5">
          {product.features.map((feature) => (
            <li key={feature} className="flex items-center gap-2 text-[12px] text-slate-300">
              <CheckCircle2 size={13} className="shrink-0 text-cyan-400" />
              {feature}
            </li>
          ))}
        </ul>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <Link
            to={`/business-apps/${product.slug}`}
            className={`inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest transition-colors hover:text-white ${
              live ? 'text-cyan-300' : 'text-slate-400'
            }`}
          >
            Learn more
            <ArrowRight size={14} />
          </Link>
          {product.download ? (
            <a
              href={product.download.href}
              download={product.download.filename}
              className="inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-fuchsia-300 transition-colors hover:text-white"
            >
              <Download size={13} />
              Download app
            </a>
          ) : null}
        </div>
      </article>
    </Reveal>
  )
}

export function BusinessAppsPage() {
  const { t } = useI18n()

  usePageMeta(
    'Preyone 360 — One suite for every part of your business',
    'Preyone 360 brings POS, invoicing, Wi-Fi, transit, home automation and a multi-tenant console together — priced per app, one login, built for Zimbabwe.',
  )

  return (
    <>
      <section className="relative pt-44 pb-8">
        <div className="container-site">
          <SectionHeading
            label={t('suite.label')}
            title={t('suite.title')}
            desc={t('suite.desc')}
          />
          <Reveal delay={0.1}>
            <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link to="/#contact" className="btn-primary px-7 py-3.5 text-sm uppercase tracking-wide">
                {t('cta.demo')}
                <ArrowRight size={16} />
              </Link>
              <a
                href="#apps"
                className="glass inline-flex items-center gap-2 rounded-xl px-7 py-3.5 text-sm font-bold uppercase tracking-wide text-slate-200 transition-colors hover:text-white"
              >
                {t('cta.explore')}
                <Sparkles size={15} />
              </a>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="relative py-10">
        <div className="container-site grid grid-cols-2 gap-4 sm:grid-cols-4">
          {SUITE_STATS.map((stat, i) => (
            <Reveal key={stat.label} delay={(i % 4) * 0.06}>
              <div className="glass rounded-2xl px-5 py-6 text-center">
                <p className="font-display text-4xl leading-none text-white">
                  <CountUp value={stat.value} suffix={stat.suffix} />
                </p>
                <p className="mt-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                  {stat.label}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      <section id="apps" className="relative scroll-mt-28 py-16">
        <div className="container-site">
          <SectionHeading
            label="Live today"
            title="Six apps, one login"
            desc="These are not mock-ups — every app below is running in production for Preyone customers."
          />
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {SUITE_PRODUCTS.map((product, i) => (
              <ProductCard key={product.slug} product={product} index={i} />
            ))}
          </div>
        </div>
      </section>

      <section className="relative py-16">
        <div className="container-site">
          <SectionHeading
            label="Roadmap"
            title="What's next"
            desc="The next apps share the same customer record, so nothing gets typed twice."
          />
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {SUITE_ROADMAP.map((product, i) => (
              <ProductCard key={product.slug} product={product} index={i} />
            ))}
          </div>
        </div>
      </section>

      <section className="relative py-16">
        <div className="container-site">
          <Reveal>
            <div className="glass glow-cyan rounded-3xl p-8 sm:p-10">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <span className="chip">Lead to cash</span>
                  <h2 className="text-gradient font-display mt-3 text-4xl leading-none tracking-wide sm:text-5xl">
                    From first enquiry to money in the bank
                  </h2>
                  <p className="mt-3 max-w-2xl text-sm leading-relaxed text-slate-400">
                    The same data follows the customer from the first call to the paid invoice — no
                    exports, no reconciliation, no re-keying.
                  </p>
                </div>
                <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                  Illustrative data
                </span>
              </div>

              <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                {LEAD_TO_CASH.map((metric) => (
                  <div key={metric.label} className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
                    <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                      {metric.label}
                    </p>
                    <p className="font-display mt-2 text-3xl leading-none text-white">
                      {metric.money && <span className="text-gradient-cyan">$</span>}
                      <CountUp value={metric.value} suffix={metric.suffix ?? ''} />
                    </p>
                    <p className="mt-2 text-[11px] text-slate-500">{metric.hint}</p>
                  </div>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="relative py-16">
        <div className="container-site">
          <SectionHeading
            label="Built for Zimbabwe"
            title="Local where it matters"
            desc="Generic software makes you bolt on local payments and compliance. Preyone builds them in."
          />
          <div className="grid gap-5 sm:grid-cols-2">
            {LOCAL_FEATURES.map((feature, i) => (
              <Reveal key={feature.title} delay={(i % 2) * 0.06} className="h-full">
                <div className="glass mesh-card h-full rounded-2xl p-6">
                  <div className="mb-4 inline-flex h-11 w-11 items-center justify-center rounded-xl border border-cyan-400/30 bg-cyan-400/8 text-cyan-300">
                    <CheckCircle2 size={20} />
                  </div>
                  <h3 className="font-display text-2xl tracking-wide text-white">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">{feature.desc}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="relative py-16">
        <div className="container-site">
          <Reveal>
            <div className="glass rounded-3xl p-8 sm:p-10">
              <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
                <div>
                  <span className="chip">Pricing</span>
                  <h2 className="text-gradient font-display mt-3 text-4xl leading-none tracking-wide sm:text-5xl">
                    Priced app by app
                  </h2>
                  <p className="mt-3 max-w-xl text-sm leading-relaxed text-slate-400">
                    Start with one app and add more as you grow. Monthly or yearly — no setup fees,
                    no forced bundle.
                  </p>
                </div>
                <Link
                  to="/#contact"
                  className="btn-primary shrink-0 px-7 py-3.5 text-sm uppercase tracking-wide"
                >
                  Request pricing
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

      <TrustBand
        title="Outgrown your current setup?"
        desc="Bring your data, keep your workflows, and go live without a long implementation."
      />
    </>
  )
}
