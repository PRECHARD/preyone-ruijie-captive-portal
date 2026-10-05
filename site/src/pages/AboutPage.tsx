import { ArrowRight, Compass, HeartHandshake, ShieldCheck, Zap } from 'lucide-react'
import { Link } from 'react-router-dom'
import { CountUp } from '../components/CountUp'
import { Reveal } from '../components/Reveal'
import { SectionHeading } from '../components/SectionHeading'
import { HERO_STATS } from '../lib/data'
import { usePageMeta } from '../hooks/usePageMeta'

const TIMELINE = [
  { year: '2019', title: 'Preyone founded', text: 'Started as a technology services firm serving Harare SMEs with repairs, networks and connectivity.' },
  { year: '2021', title: 'Software studio opens', text: 'Built our first client web platforms and enterprise systems, growing a full-stack engineering team.' },
  { year: '2023', title: 'E-commerce & client systems', text: 'Delivered online stores with mobile-money payments, bookings and order tracking for retailers.' },
  { year: '2024', title: 'UltraNet WiFi & captive portals', text: 'Launched voucher-based WiFi authentication for Ruijie gateways with RADIUS and self-service accounts.' },
  { year: '2025', title: 'Preyone Transit', text: 'Shipped the nationwide bus-ticketing and fleet-tracking platform used by thousands of riders.' },
  { year: '2026', title: 'Authorised Starlink reseller', text: 'Became an authorised Starlink reseller, bringing reliable satellite internet to every corner of Zimbabwe.' },
]

const VALUES = [
  {
    icon: Zap,
    title: 'We Ship',
    text: 'Fast, working products. We move from idea to production without endless meetings.',
    accent: 'text-cyan-300 border-cyan-400/30 bg-cyan-400/8',
  },
  {
    icon: HeartHandshake,
    title: 'Local Support',
    text: 'Real humans in Harare who answer the phone and stand behind every install.',
    accent: 'text-fuchsia-300 border-fuchsia-400/30 bg-fuchsia-400/8',
  },
  {
    icon: ShieldCheck,
    title: 'Security First',
    text: 'Hardened networks, audited code and backups — because your data matters.',
    accent: 'text-indigo-300 border-indigo-400/30 bg-indigo-400/8',
  },
  {
    icon: Compass,
    title: 'Long-term Partner',
    text: 'We build relationships, not one-off transactions. Your growth is our metric.',
    accent: 'text-amber-300 border-amber-400/30 bg-amber-400/8',
  },
]

export function AboutPage() {
  usePageMeta(
    'About Us — Preyone | Technology & Connectivity Solutions Zimbabwe',
    'Learn about Preyone Enterprises — Zimbabwe\'s authorised Starlink reseller and full-stack technology partner since 2019.',
  )

  return (
    <>
      <section className="relative pt-44 pb-20">
        <div className="container-site">
          <SectionHeading
            label="Who We Are"
            title="Built in Zimbabwe, for Zimbabwe"
            desc="Preyone is a technology & connectivity company on a mission to close Zimbabwe's digital divide — one connection, one product at a time."
          />

          <Reveal delay={0.1}>
            <div className="mx-auto max-w-3xl text-center">
              <p className="text-base leading-relaxed text-slate-300 sm:text-lg">
                We are engineers, network specialists and hardware experts who believe great
                technology should be accessible everywhere — from Harare boardrooms to rural
                classrooms. That belief drives everything we build.
              </p>
            </div>
          </Reveal>

          <Reveal delay={0.16}>
            <div className="mx-auto mt-14 grid max-w-4xl grid-cols-2 gap-6 sm:grid-cols-4">
              {HERO_STATS.map((stat) => (
                <div key={stat.label} className="glass rounded-2xl px-5 py-6 text-center">
                  <p className="font-display text-4xl text-transparent">
                    <span className="bg-gradient-to-r from-cyan-400 to-fuchsia-500 bg-clip-text">
                      <CountUp value={stat.value} suffix={stat.suffix} />
                    </span>
                  </p>
                  <p className="mt-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-500">{stat.label}</p>
                </div>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      <section className="relative py-20">
        <div className="container-site">
          <SectionHeading label="Our Story" title="The Journey" />
          <div className="mx-auto max-w-3xl">
            {TIMELINE.map((item, i) => (
              <Reveal key={item.year} delay={i * 0.05}>
                <div className="relative flex gap-6 pb-10 last:pb-0">
                  {i !== TIMELINE.length - 1 && (
                    <span className="absolute left-[17px] top-10 h-full w-px bg-gradient-to-b from-cyan-400/60 to-transparent" />
                  )}
                  <span className="relative z-10 mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-cyan-400/40 bg-panel-2 font-display text-sm text-cyan-300 shadow-[0_0_18px_rgba(0,212,255,0.35)]">
                    {i + 1}
                  </span>
                  <div className="glass flex-1 rounded-2xl p-6">
                    <span className="text-xs font-bold uppercase tracking-widest text-cyan-300">{item.year}</span>
                    <h3 className="mt-1 font-display text-2xl tracking-wide text-white">{item.title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{item.text}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="relative py-20">
        <div className="container-site">
          <SectionHeading label="What We Stand For" title="Our Values" />
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {VALUES.map((value, i) => {
              const Icon = value.icon
              return (
                <Reveal key={value.title} delay={(i % 4) * 0.08} className="h-full">
                  <div className="glass mesh-card h-full rounded-3xl p-6">
                    <div className={`mb-5 flex h-12 w-12 items-center justify-center rounded-2xl border ${value.accent}`}>
                      <Icon size={22} />
                    </div>
                    <h3 className="font-display text-2xl tracking-wide text-white">{value.title}</h3>
                    <p className="mt-2 text-sm leading-relaxed text-slate-400">{value.text}</p>
                  </div>
                </Reveal>
              )
            })}
          </div>

          <Reveal delay={0.2}>
            <div className="glass glow-brand mx-auto mt-16 flex max-w-4xl flex-col items-center justify-between gap-6 rounded-3xl px-8 py-10 text-center sm:flex-row sm:text-left">
              <div>
                <h3 className="font-display text-3xl tracking-wide text-white sm:text-4xl">
                  Ready to <span className="text-gradient">work with us?</span>
                </h3>
                <p className="mt-1 text-sm text-slate-400">Let's talk about your connectivity, hardware or software needs.</p>
              </div>
              <Link to="/#contact" className="btn-primary shrink-0 px-7 py-3.5 text-sm uppercase tracking-wide">
                Start a Project
                <ArrowRight size={16} />
              </Link>
            </div>
          </Reveal>
        </div>
      </section>
    </>
  )
}