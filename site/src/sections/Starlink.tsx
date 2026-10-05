import { Check, SatelliteDish } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Reveal } from '../components/Reveal'
import { SectionHeading } from '../components/SectionHeading'
import { TiltCard } from '../components/TiltCard'

const STORAGE_IDS = [
  { price: '$480', note: 'from', bullets: ['Unlimited data', 'Weather-resistant', 'Professional install available'] },
  { price: '$350', note: 'one-time', bullets: ['Portable & lightweight', 'Up to 100 Mbps', 'Self-install in minutes'] },
]

const KITS = [
  {
    name: 'Starlink Standard Kit',
    tag: 'Best for homes & businesses',
    desc: 'Full-size residential dish with high-throughput antenna — robust connectivity for whole households and offices.',
    img: '/images/starlink-standard-kit.png',
    imgAlt: 'Starlink Standard Kit',
    accent: 'from-amber-500/20 to-transparent',
    ring: 'ring-amber-400/40',
    index: 0,
  },
  {
    name: 'Starlink Mini Kit',
    tag: 'Most Popular — travel ready',
    desc: 'Compact, portable satellite kit ideal for remote work, travel and backup connectivity.',
    img: '/images/starlink-mini-kit.png',
    imgAlt: 'Starlink Mini Kit',
    accent: 'from-fuchsia-500/20 to-transparent',
    ring: 'ring-fuchsia-400/40',
    index: 1,
  },
] as const

export function Starlink() {
  return (
    <section id="starlink" className="relative py-24">
      <div className="container-site">
        <SectionHeading
          label="Authorised Starlink Reseller"
          title="Satellite Internet Kits"
          desc="Get connected anywhere in Zimbabwe with high-speed, low-latency satellite internet. Kits include warranty and local support."
        />

        <div className="grid gap-8 lg:grid-cols-2">
          {KITS.map((kit, i) => (
            <Reveal key={kit.name} delay={i * 0.12} className="h-full">
              <TiltCard max={6} className="h-full">
                <article
                  className={`mesh-card glass relative flex h-full flex-col overflow-hidden rounded-3xl p-7 transition-colors duration-300 hover:border-white/20 sm:p-9`}
                >
                  <div className={`pointer-events-none absolute inset-0 bg-gradient-to-br ${kit.accent}`} />
                  <div className="relative flex items-start justify-between gap-4">
                    <div>
                      <span className="chip mb-4">
                        <SatelliteDish size={13} />
                        Starlink Kit
                      </span>
                      <h3 className="font-display text-3xl tracking-wide text-white sm:text-4xl">{kit.name}</h3>
                      <p className="mt-2 text-sm text-amber-300/90">{kit.tag}</p>
                    </div>
                  </div>

                  <p className="relative mt-4 text-sm leading-relaxed text-slate-400">{kit.desc}</p>

                  <div className="relative mt-6 flex items-center justify-center rounded-2xl border border-white/10 bg-ink/60 p-5">
                    <img
                      src={kit.img}
                      alt={kit.imgAlt}
                      width={320}
                      height={260}
                      className="h-auto w-full max-w-none object-contain drop-shadow-[0_16px_30px_rgba(0,0,0,0.5)]"
                    />
                  </div>

                  <ul className="relative mt-6 grid gap-2.5">
                    {STORAGE_IDS[kit.index].bullets.map((b) => (
                      <li key={b} className="flex items-center gap-2.5 text-sm text-slate-300">
                        <Check size={15} className="shrink-0 text-cyan-400" />
                        {b}
                      </li>
                    ))}
                  </ul>

                  <div className="relative mt-7 flex flex-wrap items-center justify-between gap-4 border-t border-white/8 pt-6">
                    <div className="flex items-baseline gap-2">
                      <span className="font-display text-4xl tracking-wide text-white">{STORAGE_IDS[kit.index].price}</span>
                      <span className="text-xs text-slate-500">{STORAGE_IDS[kit.index].note}</span>
                    </div>
                    <Link to="/#contact" className="btn-primary px-6 py-3 text-xs uppercase tracking-wide">
                      Order Now
                    </Link>
                  </div>
                </article>
              </TiltCard>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  )
}