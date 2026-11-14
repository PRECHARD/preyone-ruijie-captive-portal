import { ArrowLeft, ArrowRight, CheckCircle2, Download, ExternalLink } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { Reveal } from '../components/Reveal'
import { SectionHeading } from '../components/SectionHeading'
import { TrustBand } from '../components/TrustBand'
import { usePageMeta } from '../hooks/usePageMeta'
import { SUITE_PRODUCTS, findSuiteProduct } from '../lib/suite'

export function ProductPage() {
  const { slug = '' } = useParams()
  const product = findSuiteProduct(slug)

  usePageMeta(
    product ? `${product.name} — ${product.category} | Preyone 360` : 'App not found | Preyone 360',
    product?.desc,
  )

  if (!product) {
    return (
      <section className="relative pt-44 pb-24">
        <div className="container-site text-center">
          <SectionHeading
            label="Preyone 360"
            title="That app is not here"
            desc="The app you were looking for does not exist. Browse the full suite instead."
          />
          <Link to="/business-apps" className="btn-primary inline-flex px-7 py-3.5 text-sm uppercase tracking-wide">
            Back to the suite
            <ArrowRight size={16} />
          </Link>
        </div>
      </section>
    )
  }

  const Icon = product.icon
  const live = product.status === 'live'
  const related = SUITE_PRODUCTS.filter((item) => item.slug !== product.slug).slice(0, 3)

  return (
    <>
      <section className="relative pt-40 pb-10">
        <div className="container-site">
          <Link
            to="/business-apps"
            className="mb-8 inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-400 transition-colors hover:text-white"
          >
            <ArrowLeft size={14} />
            All apps
          </Link>

          <div className="grid gap-10 lg:grid-cols-[1.2fr_0.8fr] lg:items-start">
            <Reveal>
              <div className="flex items-center gap-3">
                <div
                  className={`inline-flex items-center justify-center rounded-2xl bg-gradient-to-br ${product.gradient} p-3.5 text-white shadow-lg`}
                >
                  <Icon size={28} />
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

              <p className="mt-6 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-300">
                {product.category}
              </p>
              <h1 className="text-gradient font-display mt-2 text-5xl leading-none tracking-wide sm:text-6xl">
                {product.name}
              </h1>
              <p className="mt-4 max-w-2xl text-lg font-semibold leading-relaxed text-slate-200">
                {product.tagline}
              </p>
              <p className="mt-4 max-w-2xl text-sm leading-relaxed text-slate-400">{product.desc}</p>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                {product.download ? (
                  <a
                    href={product.download.href}
                    download={product.download.filename}
                    className="btn-primary inline-flex items-center justify-center px-7 py-3.5 text-sm uppercase tracking-wide"
                  >
                    <Download size={15} />
                    {product.download.label}
                  </a>
                ) : live && product.external ? (
                  <a
                    href={product.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn-primary inline-flex items-center justify-center px-7 py-3.5 text-sm uppercase tracking-wide"
                  >
                    Open app
                    <ExternalLink size={15} />
                  </a>
                ) : (
                  <Link
                    to="/#contact"
                    className="btn-primary inline-flex items-center justify-center px-7 py-3.5 text-sm uppercase tracking-wide"
                  >
                    Register interest
                    <ArrowRight size={16} />
                  </Link>
                )}
                <Link
                  to="/#contact"
                  className="glass inline-flex items-center justify-center gap-2 rounded-xl px-7 py-3.5 text-sm font-bold uppercase tracking-wide text-slate-200 transition-colors hover:text-white"
                >
                  Book a demo
                  <ArrowRight size={15} />
                </Link>
              </div>
              {product.download ? (
                <p className="mt-3 text-xs text-slate-500">
                  {product.download.platform ?? 'Mobile'} app. If your phone blocks the install,
                  allow “Install unknown apps” for your browser and try again.
                </p>
              ) : null}
            </Reveal>

            <Reveal delay={0.1}>
              <div className="glass rounded-3xl p-7">
                <h2 className="font-display text-2xl tracking-wide text-white">What you get</h2>
                <ul className="mt-5 grid gap-3">
                  {product.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-2.5 text-sm text-slate-300">
                      <CheckCircle2 size={16} className="shrink-0 text-cyan-400" />
                      {feature}
                    </li>
                  ))}
                </ul>
                <div className="mt-6 border-t border-white/8 pt-5">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Works with</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {product.worksWith.map((item) => (
                      <span key={item} className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-slate-300">
                        {item}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      <section className="relative py-16">
        <div className="container-site">
          <SectionHeading
            label="Who it's for"
            title="Built for the way you work"
            desc={`${product.name} is designed for teams that need the job done without another spreadsheet.`}
            align="left"
          />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {product.whoFor.map((item, i) => (
              <Reveal key={item} delay={(i % 4) * 0.06}>
                <div className="glass mesh-card rounded-2xl p-5 text-sm font-semibold text-slate-200">
                  {item}
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="relative py-16">
        <div className="container-site">
          <SectionHeading
            label="More from the suite"
            title="Add another app"
            desc="Every app shares the same customer record, so the next one is easier than the last."
          />
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {related.map((item, i) => {
              const RelatedIcon = item.icon
              return (
                <Reveal key={item.slug} delay={(i % 3) * 0.06} className="h-full">
                  <Link
                    to={`/business-apps/${item.slug}`}
                    className="mesh-card glass flex h-full flex-col rounded-3xl p-7 transition-all duration-300 hover:-translate-y-1 hover:border-white/20"
                  >
                    <div className={`inline-flex w-fit items-center justify-center rounded-2xl bg-gradient-to-br ${item.gradient} p-3 text-white`}>
                      <RelatedIcon size={22} />
                    </div>
                    <p className="mt-5 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-300">
                      {item.category}
                    </p>
                    <h3 className="font-display text-2xl tracking-wide text-white">{item.name}</h3>
                    <p className="mt-2 flex-1 text-sm leading-relaxed text-slate-400">{item.tagline}</p>
                    <span className="mt-5 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-cyan-300">
                      Learn more
                      <ArrowRight size={13} />
                    </span>
                  </Link>
                </Reveal>
              )
            })}
          </div>
        </div>
      </section>

      <TrustBand title={`Ready to try ${product.name}?`} />
    </>
  )
}
