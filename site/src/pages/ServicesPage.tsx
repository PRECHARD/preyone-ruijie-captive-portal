import { ArrowRight, CheckCircle2, ClipboardList, Rocket, Wrench } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Reveal } from '../components/Reveal'
import { SectionHeading } from '../components/SectionHeading'
import { SERVICES } from '../lib/data'
import { usePageMeta } from '../hooks/usePageMeta'

const PROCESS = [
  {
    icon: ClipboardList,
    step: '01',
    title: 'Discover',
    text: 'We audit your current setup and map the goals, constraints and budget for your project.',
  },
  {
    icon: Wrench,
    step: '02',
    title: 'Design & Build',
    text: 'Architecture, hardware sourcing or code — our engineers deliver working systems fast.',
  },
  {
    icon: Rocket,
    step: '03',
    title: 'Deploy',
    text: 'Installs, cutovers, integrations and go-lives handled end-to-end, with zero downtime plans.',
  },
  {
    icon: CheckCircle2,
    step: '04',
    title: 'Support & Scale',
    text: 'SLAs, monitoring, refreshes and growth roadmaps so your technology scales with you.',
  },
]

export function ServicesPage() {
  usePageMeta(
    'Services — Preyone | Networking, Hardware, Surveillance & Software',
    'Preyone services: Starlink & connectivity, IT hardware, networking, AI surveillance, managed IT and software development in Zimbabwe.',
  )

  return (
    <>
      <section className="relative pt-44 pb-8">
        <div className="container-site">
          <SectionHeading
            label="Infrastructure & Support"
            title="Everything Under One Roof"
            desc="Eight core practices covering the full technology lifecycle for homes, schools, SMEs and enterprises."
          />
        </div>
      </section>

      <section className="relative py-12">
        <div className="container-site grid gap-6 sm:grid-cols-2">
          {SERVICES.map((service, i) => {
            const Icon = service.icon
            return (
              <Reveal key={service.title} delay={(i % 2) * 0.08} className="h-full">
                <article className="mesh-card glass relative flex h-full flex-col overflow-hidden rounded-3xl p-8 transition-all duration-300 hover:-translate-y-1 hover:border-white/20">
                  <div className={`mb-6 inline-flex w-fit items-center justify-center rounded-2xl bg-gradient-to-br ${service.gradient} p-3.5 text-white shadow-lg`}>
                    <Icon size={26} />
                  </div>
                  <h3 className="font-display text-3xl tracking-wide text-white">{service.title}</h3>
                  <p className="mt-2.5 text-sm leading-relaxed text-slate-400">{service.desc}</p>
                  <ul className="mt-6 grid flex-1 grid-cols-1 gap-2.5 border-t border-white/8 pt-6 sm:grid-cols-2">
                    {service.features.map((f) => (
                      <li key={f} className="flex items-center gap-2 text-[13px] text-slate-300">
                        <CheckCircle2 size={14} className="shrink-0 text-cyan-400" />
                        {f}
                      </li>
                    ))}
                  </ul>
                  <Link
                    to="/#contact"
                    className="mt-7 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-cyan-300 transition-colors hover:text-white"
                  >
                    Request a quote
                    <ArrowRight size={14} />
                  </Link>
                </article>
              </Reveal>
            )
          })}
        </div>
      </section>

      <section className="relative py-20">
        <div className="container-site">
          <SectionHeading label="How We Work" title="The Preyone Process" />
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {PROCESS.map((phase, i) => {
              const Icon = phase.icon
              return (
                <Reveal key={phase.title} delay={(i % 4) * 0.08} className="h-full">
                  <div className="glass mesh-card relative h-full overflow-hidden rounded-3xl p-6">
                    <span className="absolute -right-2 -top-4 font-display text-[90px] leading-none text-white/6">
                      {phase.step}
                    </span>
                    <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border border-cyan-400/30 bg-cyan-400/8 text-cyan-300">
                      <Icon size={22} />
                    </div>
                    <h3 className="font-display text-2xl tracking-wide text-white">{phase.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-400">{phase.text}</p>
                  </div>
                </Reveal>
              )
            })}
          </div>

          <Reveal delay={0.2}>
            <div className="glass glow-cyan mx-auto mt-16 flex max-w-4xl flex-col items-center justify-between gap-6 rounded-3xl px-8 py-10 text-center sm:flex-row sm:text-left">
              <div>
                <h3 className="font-display text-3xl tracking-wide text-white sm:text-4xl">
                  Not sure what you need?
                </h3>
                <p className="mt-1 text-sm text-slate-400">Book a free consultation — we'll map the right solution.</p>
              </div>
              <Link to="/#contact" className="btn-primary shrink-0 px-7 py-3.5 text-sm uppercase tracking-wide">
                Talk to an Expert
                <ArrowRight size={16} />
              </Link>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  )
}