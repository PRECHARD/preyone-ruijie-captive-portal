import { ContactForm } from '../components/ContactForm'
import { Reveal } from '../components/Reveal'
import { SectionHeading } from '../components/SectionHeading'

export function Contact() {
  return (
    <section id="contact" className="relative py-24">
      <div className="container-site">
        <SectionHeading
          label="Stay Updated"
          title="Let's Build Something Great"
          desc="Ready to get connected, buy equipment, or start a project? Reach out to the Preyone team today."
        />

        <div className="grid gap-8">
          <Reveal className="mx-auto w-full max-w-4xl">
            <div className="glass mesh-card relative rounded-3xl p-7 sm:p-9">
              <ContactForm />
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  )
}