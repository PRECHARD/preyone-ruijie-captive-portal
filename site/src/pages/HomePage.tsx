import { Contact } from '../sections/Contact'
import { Hero } from '../sections/Hero'
import { Portfolio } from '../sections/Portfolio'
import { Services } from '../sections/Services'
import { Starlink } from '../sections/Starlink'
import { TechShowcase } from '../sections/TechShowcase'
import { usePageMeta } from '../hooks/usePageMeta'

export function HomePage() {
  usePageMeta(
    'Preyone — Starlink & Technology Solutions Zimbabwe | preyone.com',
    'Preyone — Zimbabwe\'s technology & connectivity company. Authorised Starlink reseller, IT hardware, networking, surveillance, and software development.',
  )

  return (
    <>
      <Hero />
      <Starlink />
      <TechShowcase />
      <Services />
      <Portfolio />
      <Contact />
    </>
  )
}