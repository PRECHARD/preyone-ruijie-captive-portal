import { ArrowUpRight } from 'lucide-react'
import { CountUp } from './CountUp'
import { TiltCard } from './TiltCard'
import type { Project } from '../lib/data'

export function ProjectCard({ project }: { project: Project }) {
  const Icon = project.icon
  return (
    <TiltCard max={5} className="h-full">
      <article className="mesh-card glass relative flex h-full flex-col overflow-hidden rounded-3xl p-7 transition-colors duration-300 hover:border-white/20">
        <div className="relative mb-6 flex items-center justify-between gap-3">
          <div
            className={`flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br ${project.accent} p-3 text-white shadow-lg`}
          >
            <Icon size={26} />
          </div>
          <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-bold uppercase tracking-widest text-slate-400">
            {project.category}
          </span>
          <span className="text-xs font-bold text-slate-500">{project.year}</span>
        </div>

        <h3 className="font-display text-3xl tracking-wide text-white">{project.name}</h3>
        <p className="mt-2.5 text-sm leading-relaxed text-slate-400">{project.description}</p>

        <div className="mt-6 grid grid-cols-3 gap-3 rounded-2xl border border-white/10 bg-ink/50 p-4">
          {project.metrics.map((metric) => (
            <div key={metric.label} className="text-center">
              <p className="font-display text-2xl text-transparent">
                <span className="bg-gradient-to-r from-cyan-400 to-fuchsia-500 bg-clip-text">
                  <CountUp value={metric.value} suffix={metric.suffix} />
                </span>
              </p>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">{metric.label}</p>
            </div>
          ))}
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {project.stack.map((tech) => (
            <span
              key={tech}
              className="rounded-lg border border-white/10 bg-white/4 px-2.5 py-1 text-[11px] font-bold text-slate-300"
            >
              {tech}
            </span>
          ))}
        </div>

        <div className="mt-auto pt-6">
          <a
            href={project.link}
            target={project.link.startsWith('http') ? '_blank' : undefined}
            rel={project.link.startsWith('http') ? 'noopener noreferrer' : undefined}
            className="group/link inline-flex items-center gap-1.5 text-xs font-bold uppercase tracking-widest text-fuchsia-300 transition-colors hover:text-white"
          >
            {project.linkLabel}
            <ArrowUpRight size={15} className="transition-transform duration-200 group-hover/link:translate-x-0.5 group-hover/link:-translate-y-0.5" />
          </a>
        </div>
      </article>
    </TiltCard>
  )
}