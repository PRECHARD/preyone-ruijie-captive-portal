import { motion } from 'framer-motion'
import { ArrowRight, ShieldCheck, Sparkles, Zap } from 'lucide-react'
import { Link } from 'react-router-dom'
import { CountUp } from '../components/CountUp'
import { HERO_STATS } from '../lib/data'

const container = {
  hidden: {},
  show: { transition: { staggerChildren: 0.12, delayChildren: 0.08 } },
}

const item = {
  hidden: { opacity: 0, y: 26 },
  show: { opacity: 1, y: 0, transition: { duration: 0.65, ease: [0.22, 1, 0.36, 1] as const } },
}

export function Hero() {
  return (
    <section className="relative overflow-hidden pt-36 pb-20 sm:pt-44 lg:pb-28">
      <div className="container-site grid items-center gap-14 lg:grid-cols-[1.1fr_0.9fr]">
        <motion.div variants={container} initial="hidden" animate="show" className="flex flex-col items-start gap-6">
          <motion.span variants={item} className="chip">
            <Sparkles size={13} />
            Technology & Connectivity — Zimbabwe
          </motion.span>

          <motion.h1
            variants={item}
            className="font-display text-[clamp(44px,6.5vw,88px)] leading-[0.92] tracking-wide text-white"
          >
            Powering Zimbabwe&rsquo;s
            <br />
            <span className="text-gradient">Digital Future</span>
          </motion.h1>

          <motion.p variants={item} className="max-w-xl text-sm leading-relaxed text-slate-400 sm:text-base">
            From Starlink satellite internet and the latest gaming laptops to enterprise networking,
            AI surveillance and world-class software — Preyone is your end-to-end technology partner.
          </motion.p>

          <motion.div variants={item} className="flex flex-wrap items-center gap-4">
            <Link to="/#hardware" className="btn-primary px-7 py-3.5 text-sm uppercase tracking-wide">
              Explore Hardware
              <ArrowRight size={16} />
            </Link>
            <Link to="/portfolio" className="btn-ghost px-7 py-3.5 text-sm uppercase tracking-wide">
              View Our Work
            </Link>
          </motion.div>

          <motion.div variants={item} className="mt-4 grid w-full max-w-xl grid-cols-2 gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 sm:grid-cols-4">
            {HERO_STATS.map((stat) => (
              <div key={stat.label} className="flex flex-col gap-1 bg-panel/90 px-4 py-4">
                <span className="font-display text-2xl text-white sm:text-3xl">
                  <CountUp value={stat.value} suffix={stat.suffix} />
                </span>
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{stat.label}</span>
              </div>
            ))}
          </motion.div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.8, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
          className="relative mx-auto w-full max-w-md lg:max-w-none"
        >
          <div className="animate-pulse-ring absolute inset-0 rounded-[2rem] border border-fuchsia-400/30" />
          <div className="animate-pulse-ring absolute inset-0 rounded-[2rem] border border-cyan-400/30 [animation-delay:1.2s]" />

          <div className="glass glow-brand mesh-card relative overflow-hidden rounded-[2rem] p-6 sm:p-8">
            <div className="relative flex items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-ink/70 p-6">
              <div className="noise absolute inset-0" />
              <img
                src="/images/preyonelogomainzw.png"
                alt="Preyone Insider Program"
                width={800}
                height={800}
                loading="eager"
                className="animate-float relative w-full max-w-[17rem] drop-shadow-[0_18px_40px_rgba(0,212,255,0.28)]"
              />

              <span className="animate-float-slow absolute top-4 right-4 flex items-center gap-1.5 rounded-full border border-cyan-400/30 bg-cyan-400/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-cyan-200">
                <Zap size={11} />
                Insider Access
              </span>
              <span className="animate-float absolute bottom-4 left-4 flex items-center gap-1.5 rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-fuchsia-200">
                <ShieldCheck size={11} />
                Preyone Members
              </span>
            </div>

            <div className="mt-6 grid grid-cols-3 gap-3 text-center">
              {['Satellite Internet', 'Latest Hardware', 'Software Dev'].map((t) => (
                <div key={t} className="rounded-xl border border-white/10 bg-white/4 px-2 py-3">
                  <p className="text-[10px] font-bold uppercase tracking-wider text-slate-300 sm:text-xs">{t}</p>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  )
}