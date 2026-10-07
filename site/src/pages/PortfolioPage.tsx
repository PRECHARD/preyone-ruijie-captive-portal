import { ArrowRight, FolderOpen } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ProjectCard } from '../components/ProjectCard'
import { Reveal } from '../components/Reveal'
import { SectionHeading } from '../components/SectionHeading'
import { CountUp } from '../components/CountUp'
import { PROJECTS } from '../lib/data'
import { usePageMeta } from '../hooks/usePageMeta'

const PLATFORM_STATS = [
  { value: 24, suffix: 'k+', label: 'Transit riders' },
  { value: 96, suffix: '', label: 'WiFi users online' },
  { value: 12, suffix: 'k+', label: 'Voucher redemptions' },
  { value: 8, suffix: 'k+', label: 'Client e-orders' },
]

const CLIENT_CASES = [
  'Custom school fees & student management portals',
  'B2B procurement and inventory systems',
  'Hotel & lodge booking engines',
  'Agritech dashboards with IoT sensor feeds',
  'POS + stock reconciliation for retailers',
  'Internal tools, reporting & HR workflows',
]

export function PortfolioPage() {
  usePageMeta(
    'Portfolio — Preyone | Transit, Captive Portals & Client Web Systems',
    'Explore Preyone\'s portfolio: Preyone Transit, captive portals, WiFi authentication and client web systems built for Zimbabwe.',
  )

  return (
    <>
      <section className="relative pt-44 pb-8">
        <div className="container-site">
          <SectionHeading
            label="Developed Websites & Platforms"
            title="Products We've Shipped"
            desc="Every project below is in production, serving real users daily across Zimbabwe."
          />
        </div>
      </section>

      <section id="transit" className="relative py-12">
        <div className="container-site grid gap-7 md:grid-cols-2">
          {PROJECTS.slice(0, 2).map((project, i) => (
            <Reveal key={project.name} delay={i * 0.1} className="h-full">
              <ProjectCard project={project} />
            </Reveal>
          ))}
        </div>
      </section>

      <section className="relative py-12">
        <div className="container-site">
          <Reveal>
            <div className="glass glow-brand overflow-hidden rounded-3xl">
              <div className="grid gap-6 p-8 sm:grid-cols-2 lg:grid-cols-4 sm:p-10">
                {PLATFORM_STATS.map((stat) => (
                  <div key={stat.label} className="text-center">
                    <p className="font-display text-4xl text-transparent">
                      <span className="bg-gradient-to-r from-cyan-400 to-fuchsia-500 bg-clip-text">
                        <CountUp value={stat.value} suffix={stat.suffix} />
                      </span>
                    </p>
                    <p className="mt-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">{stat.label}</p>
                  </div>
                ))}
              </div>
              <div className="px-8 pb-8 sm:px-10 sm:pb-10">
                <p className="text-sm leading-relaxed text-slate-400">
                  Platform metrics are live aggregates from production systems — uptime, users and
                  transactions tracked continuously across the network.
                </p>
              </div>
            </div>
          </Reveal>
        </div>
      </section>

      <section className="relative py-12">
        <div className="container-site grid gap-7 md:grid-cols-2">
          {PROJECTS.slice(2).map((project, i) => (
            <Reveal key={project.name} delay={i * 0.1} className="h-full">
              <ProjectCard project={project} />
            </Reveal>
          ))}
        </div>
      </section>

      <section id="client-systems" className="relative py-12">
        <div className="container-site">
          <Reveal>
            <div className="glass mesh-card relative overflow-hidden rounded-3xl p-8 sm:p-10">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <span className="chip mb-4">
                    <FolderOpen size={13} />
                    Client Work
                  </span>
                  <h3 className="font-display text-3xl tracking-wide text-white sm:text-4xl">More Client Systems</h3>
                  <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-400">
                    Beyond our own platforms, Preyone designs and ships custom systems for clients across
                    education, hospitality, retail, agriculture and more.
                  </p>
                </div>
                <Link to="/#contact" className="btn-ghost px-6 py-3 text-xs uppercase tracking-wide">
                  Start Yours
                  <ArrowRight size={14} />
                </Link>
              </div>

              <ul className="mt-8 grid gap-3 sm:grid-cols-2">
                {CLIENT_CASES.map((item) => (
                  <li key={item} className="flex items-center gap-3 rounded-xl border border-white/8 bg-ink/50 px-4 py-3 text-sm text-slate-300">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-gradient-to-r from-cyan-400 to-fuchsia-500" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  )
}