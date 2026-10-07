import { Check } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Reveal } from '../components/Reveal'
import { SectionHeading } from '../components/SectionHeading'
import { SERVICES } from '../lib/data'

export function Services() {
  return (
    <section id="services" className="relative py-24">
      <div className="container-site">
        <SectionHeading
          label="Infrastructure & Support"
          title="Our Services"
          desc="End-to-end technology services — from network design and CCTV installation to managed IT support and custom software."
        />

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {SERVICES.map((service, i) => {
            const Icon = service.icon
            return (
              <Reveal key={service.title} delay={(i % 4) * 0.08} className="h-full">
                <article className="mesh-card group glass relative flex h-full flex-col overflow-hidden rounded-3xl p-6 transition-all duration-300 hover:-translate-y-1 hover:border-white/20">
                  <div
                    className={`mb-5 inline-flex h-13 w-13 items-center justify-center rounded-2xl bg-gradient-to-br ${service.gradient} p-3 text-white shadow-lg`}
                  >
                    <Icon size={24} />
                  </div>
                  <h3 className="font-display text-2xl tracking-wide text-white transition-colors group-hover:text-fuchsia-300">
                    {service.title}
                  </h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-400">{service.desc}</p>
                  <ul className="mt-5 flex flex-1 flex-col gap-2 border-t border-white/8 pt-5">
                    {service.features.map((f) => (
                      <li key={f} className="flex items-center gap-2 text-[13px] text-slate-300">
                        <Check size={14} className="shrink-0 text-cyan-400" />
                        {f}
                      </li>
                    ))}
                  </ul>
                  <Link
                    to="/services"
                    className="mt-6 inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-fuchsia-300 transition-colors hover:text-white"
                  >
                    Learn more
                    <span aria-hidden className="transition-transform duration-200 group-hover:translate-x-1">
                      →
                    </span>
                  </Link>
                </article>
              </Reveal>
            )
          })}
        </div>
      </div>
    </section>
  )
}