import { ArrowRight, CheckCircle2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Reveal } from './Reveal'
import { TRUST_POINTS } from '../lib/suite'

type TrustBandProps = {
  title?: string
  desc?: string
}

export function TrustBand({
  title = 'Ready when you are.',
  desc = 'Book a short demo and we will map the right apps to your business.',
}: TrustBandProps) {
  return (
    <section className="relative py-16">
      <div className="container-site">
        <Reveal>
          <div className="glass glow-cyan rounded-3xl px-8 py-10 sm:px-10">
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {TRUST_POINTS.map((point) => (
                <div key={point.title} className="flex items-start gap-3">
                  <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-cyan-400" />
                  <div>
                    <p className="text-sm font-bold text-white">{point.title}</p>
                    <p className="mt-1 text-xs leading-relaxed text-slate-400">{point.desc}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-8 flex flex-col gap-4 border-t border-white/8 pt-8 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="font-display text-2xl tracking-wide text-white sm:text-3xl">{title}</h3>
                <p className="mt-1 text-sm text-slate-400">{desc}</p>
              </div>
              <Link
                to="/#contact"
                className="btn-primary shrink-0 px-7 py-3.5 text-sm uppercase tracking-wide"
              >
                Book a 20-minute demo
                <ArrowRight size={16} />
              </Link>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  )
}
