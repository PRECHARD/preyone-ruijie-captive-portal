import { ArrowUpRight, FolderGit2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { ProjectCard } from '../components/ProjectCard'
import { Reveal } from '../components/Reveal'
import { SectionHeading } from '../components/SectionHeading'
import { PROJECTS } from '../lib/data'

export function Portfolio() {
  const featured = PROJECTS.slice(0, 3)
  return (
    <section id="portfolio" className="relative py-24">
      <div className="container-site">
        <SectionHeading
          label="Developed Websites & Platforms"
          title="Our Work"
          desc="From captive portals and transit platforms to client web systems — real products in production across Zimbabwe."
        />

        <div className="grid gap-7 md:grid-cols-2 lg:grid-cols-3">
          {featured.map((project, i) => (
            <Reveal key={project.name} delay={(i % 3) * 0.1} className="h-full">
              <ProjectCard project={project} />
            </Reveal>
          ))}
        </div>

        <Reveal delay={0.15}>
          <div className="mt-12 flex justify-center">
            <Link to="/portfolio" className="btn-primary px-8 py-4 text-sm uppercase tracking-wide">
              <FolderGit2 size={16} />
              Explore the Portfolio
              <ArrowUpRight size={16} />
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  )
}