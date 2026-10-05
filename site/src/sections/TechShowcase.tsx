import { AnimatePresence, motion } from 'framer-motion'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Reveal } from '../components/Reveal'
import { SectionHeading } from '../components/SectionHeading'
import { TiltCard } from '../components/TiltCard'
import { PRODUCTS, PRODUCT_FILTERS, TECH_MARQUEE } from '../lib/data'
import type { Product, ProductCategory } from '../lib/data'

function ProductCard({ product }: { product: Product }) {
  const Icon = product.icon
  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.92, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.92, y: 12 }}
      transition={{ duration: 0.38, ease: 'easeOut' }}
      className="h-full"
    >
      <TiltCard className="h-full">
        <article className="mesh-card glass relative flex h-full flex-col overflow-hidden rounded-3xl p-6 transition-colors duration-300 hover:border-white/20">
          <div className="relative mb-5 flex items-center justify-between gap-3" style={{ transform: 'translateZ(42px)' }}>
            <div className="animate-float flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl border border-cyan-400/30 bg-cyan-400/10 text-cyan-300 shadow-[0_0_28px_rgba(0,212,255,0.25)]">
              <Icon size={24} />
            </div>
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
              {product.category}
            </span>
            {product.badge && (
              <motion.span
                animate={{ y: [0, -6, 0], rotate: [0, 6, 0] }}
                transition={{ repeat: Infinity, duration: 5, ease: 'easeInOut' }}
                className="chip rounded-xl bg-cyan-400/10 text-cyan-200"
                style={{ transform: 'rotate(4deg)' }}
              >
                {product.badge}
              </motion.span>
            )}
          </div>

          <h3 className="font-display text-[26px] leading-none tracking-wide text-white">{product.name}</h3>
          <p className="mt-2 min-h-10 text-sm leading-relaxed text-slate-400">{product.tagline}</p>

          <div className="mt-5 flex flex-1 flex-col gap-3.5">
            {product.specs.map((spec) => (
              <div key={spec.label}>
                <div className="mb-1.5 flex items-center justify-between gap-2 text-xs">
                  <span className="font-semibold uppercase tracking-wider text-slate-300">{spec.label}</span>
                  <span className="text-fuchsia-300">{spec.value}</span>
                </div>
                <div className="spec-track">
                  <motion.div
                    className="spec-fill"
                    initial={{ width: 0 }}
                    whileInView={{ width: `${spec.pct}%` }}
                    viewport={{ once: true, margin: '-40px' }}
                    transition={{ duration: 0.9, ease: 'easeOut', delay: 0.15 }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 flex items-center justify-between gap-3 border-t border-white/8 pt-5">
            <div className="flex items-baseline gap-1.5">
              <span className="font-display text-3xl leading-none tracking-wide text-white">{product.price}</span>
              <span className="text-[11px] text-slate-500">{product.priceNote}</span>
            </div>
            <Link to="/#contact" className="btn-ghost px-5 py-2.5 text-xs uppercase tracking-wide">
              Get a Quote
            </Link>
          </div>
        </article>
      </TiltCard>
    </motion.div>
  )
}

export function TechShowcase() {
  const [active, setActive] = useState<'All' | ProductCategory>('All')
  const filtered = active === 'All' ? PRODUCTS : PRODUCTS.filter((p) => p.category === active)

  return (
    <section id="hardware" className="relative py-24">
      <div className="container-site">
        <SectionHeading
          label="Latest Tech & Hardware"
          title="The Showcase"
          desc="High-end gaming laptops, flagships, mobile devices and networking gear — with warranty, configuration and local support."
        />

        {/* Marquee strip */}
        <Reveal>
          <div className="relative mb-12 overflow-hidden rounded-2xl border border-white/8 bg-panel/50 py-4 [mask-image:linear-gradient(90deg,transparent,black_12%,black_88%,transparent)]">
            <div className="animate-marquee flex w-max gap-10">
              {[0, 1].map((copy) => (
                <div key={copy} aria-hidden={copy === 1} className="flex items-center gap-10">
                  {TECH_MARQUEE.map((t) => (
                    <span key={`${copy}-${t}`} className="flex items-center gap-10 whitespace-nowrap text-xs font-bold uppercase tracking-[0.22em] text-slate-500">
                      {t}
                      <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-r from-cyan-400 to-fuchsia-500" />
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </Reveal>

        {/* Filter tabs */}
        <Reveal delay={0.08}>
          <div className="mb-10 flex flex-wrap items-center justify-center gap-2.5">
            {(['All', ...PRODUCT_FILTERS] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setActive(filter)}
                className={`rounded-full px-5 py-2.5 text-xs font-bold uppercase tracking-wider transition-all duration-200 ${
                  active === filter
                    ? 'bg-gradient-to-r from-cyan-500 to-fuchsia-500 text-white shadow-[0_8px_28px_rgba(34,211,238,0.28)]'
                    : 'border border-white/12 bg-white/4 text-slate-400 hover:border-cyan-400/40 hover:text-cyan-300'
                }`}
              >
                {filter}
              </button>
            ))}
          </div>
        </Reveal>

        <motion.div layout className="grid gap-7 sm:grid-cols-2 lg:grid-cols-3">
          <AnimatePresence mode="popLayout">
            {filtered.map((product) => (
              <ProductCard key={product.id} product={product} />
            ))}
          </AnimatePresence>
        </motion.div>
      </div>
    </section>
  )
}