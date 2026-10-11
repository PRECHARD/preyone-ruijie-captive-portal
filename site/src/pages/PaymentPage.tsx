import { LifeBuoy, Phone, ShieldCheck } from 'lucide-react'
import { ContactForm } from '../components/ContactForm'
import { Reveal } from '../components/Reveal'
import { SectionHeading } from '../components/SectionHeading'
import { StarlinkPaymentPortal } from '../components/StarlinkPaymentPortal'
import { usePageMeta } from '../hooks/usePageMeta'

export function PaymentPage() {
  usePageMeta(
    'Pay an Invoice — Preyone Starlink Zimbabwe',
    'Settle a Preyone Starlink invoice securely. Pay by card, EcoCash or ZimSwitch and receive your receipt by email instantly.',
  )

  return (
    <>
      {/* Hero ------------------------------------------------------------ */}
      <section className="relative pt-44 pb-10">
        <div className="container-site">
          <SectionHeading
            align="center"
            label="Secure Payments"
            title="Pay an Invoice"
            desc="Settle a Starlink hardware or subscription invoice. Your receipt is emailed the moment payment clears."
          />
        </div>
      </section>

      {/* Portal ----------------------------------------------------------- */}
      <section className="relative pb-16">
        <div className="container-site">
          <Reveal>
            <StarlinkPaymentPortal />
          </Reveal>
        </div>
      </section>

      {/* Trust strip ------------------------------------------------------ */}
      <section className="relative py-10">
        <div className="container-site grid gap-5 sm:grid-cols-3">
          <Reveal>
            <div className="glass flex h-full flex-col items-center gap-2.5 rounded-3xl px-6 py-7 text-center">
              <ShieldCheck size={22} className="text-emerald-400" />
              <h3 className="text-sm font-bold text-white">Encrypted end to end</h3>
              <p className="text-xs leading-relaxed text-slate-400">
                Card data never touches our servers — it goes straight to the payment gateway.
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <div className="glass flex h-full flex-col items-center gap-2.5 rounded-3xl px-6 py-7 text-center">
              <Phone size={22} className="text-cyan-400" />
              <h3 className="text-sm font-bold text-white">Instant email receipt</h3>
              <p className="text-xs leading-relaxed text-slate-400">
                Send the invoice to your accountant with one click after payment.
              </p>
            </div>
          </Reveal>
          <Reveal delay={0.16}>
            <div className="glass flex h-full flex-col items-center gap-2.5 rounded-3xl px-6 py-7 text-center">
              <LifeBuoy size={22} className="text-fuchsia-400" />
              <h3 className="text-sm font-bold text-white">Need help paying?</h3>
              <p className="text-xs leading-relaxed text-slate-400">
                Message us below with your reference and we will sort it out with you.
              </p>
            </div>
          </Reveal>
        </div>
      </section>

      {/* Fallback contact ------------------------------------------------- */}
      <section id="payment-help" className="relative py-20">
        <div className="container-site grid gap-6 lg:grid-cols-[1fr_1.1fr] lg:items-start">
          <Reveal>
            <div className="glass-strong rounded-3xl p-8">
              <span className="chip">Prefer to talk?</span>
              <h3 className="mt-5 font-display text-3xl tracking-wide text-white">
                Send us the invoice, we'll do the rest
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-slate-400">
                Bank transfer, ZimSwitch bulk settlement or a purchase order? Tell us the amount
                and reference and our team will confirm activation manually — usually the same
                working day.
              </p>
            </div>
          </Reveal>

          <Reveal delay={0.1}>
            <div className="glass mesh-card rounded-3xl p-6 sm:p-8">
              <ContactForm />
            </div>
          </Reveal>
        </div>
      </section>
    </>
  )
}