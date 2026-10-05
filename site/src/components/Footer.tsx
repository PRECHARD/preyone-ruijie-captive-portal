import { Link } from 'react-router-dom'
import { Mail, MapPin, MessageCircle, Phone } from 'lucide-react'
import { SocialLinks } from './SocialLinks'

const CONTACT_CARDS = [
  { icon: Mail, title: 'Email', value: 'support@preyone.com', href: 'mailto:support@preyone.com', accent: 'text-cyan-300 border-cyan-400/30 bg-cyan-400/8' },
  { icon: Phone, title: 'Call Us', value: '+263 771 327 202', href: 'tel:+263771327202', accent: 'text-cyan-300 border-cyan-400/30 bg-cyan-400/8' },
  { icon: MessageCircle, title: 'WhatsApp', value: 'Chat with our team', href: 'https://wa.me/263771327202', accent: 'text-fuchsia-300 border-fuchsia-400/30 bg-fuchsia-400/8' },
  { icon: MapPin, title: 'Location', value: 'Harare, Zimbabwe', href: undefined, accent: 'text-violet-300 border-violet-400/30 bg-violet-400/8' },
] as const

export function Footer() {
  return (
    <footer className="main-footer">
      <div className="footer-grid">
        <div className="footer-col brand-col">
          <Link to="/" aria-label="Preyone — home">
            <img
              src="/images/preyonelogomainzw.png"
              alt="Preyone"
              className="footer-brand-mark"
              width={1200}
              height={675}
              loading="lazy"
              decoding="async"
            />
          </Link>
          <p className="footer-tagline">
            High-speed satellite connectivity across Zimbabwe. Powered by Starlink Business Priority infrastructure.
          </p>
        </div>

        <div className="footer-col">
          <h3>GET IN TOUCH</h3>
          <div className="footer-contact-cards">
            {CONTACT_CARDS.map((card) => {
              const Icon = card.icon
              const content = (
                <>
                  <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ${card.accent}`}>
                    <Icon size={19} />
                  </div>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-[10px] font-bold uppercase tracking-widest text-slate-500">{card.title}</span>
                    <span className="footer-contact-value text-sm font-semibold text-slate-200">{card.value}</span>
                  </div>
                </>
              )

              return card.href ? (
                <a
                  key={card.title}
                  href={card.href}
                  target={card.href.startsWith('http') ? '_blank' : undefined}
                  rel={card.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                    className="glass flex min-w-0 items-center gap-3 rounded-xl p-3 transition-all duration-200 hover:-translate-y-0.5 hover:border-white/25"
                >
                  {content}
                </a>
              ) : (
                <div key={card.title} className="glass flex min-w-0 items-center gap-3 rounded-xl p-3">
                  {content}
                </div>
              )
            })}
          </div>
        </div>

        <div className="footer-col">
          <h3>FOLLOW US</h3>
          <div className="footer-follow-panel glass rounded-2xl p-4">
            <div className="footer-follow-links">
              <SocialLinks />
            </div>
          </div>
        </div>
      </div>

      <div className="footer-bottom">
        <div className="legal-row">
          <p>&copy; {new Date().getFullYear()} Preyone Enterprises. All Rights Reserved.</p>
          <div className="payment-badges">
            <span className="secure-pay-label">Secure Payments</span>
            <span className="pay-logos">
              <span className="pay-logo pay-logo--zimswitch">ZimSwitch</span>
              <span className="pay-logo pay-logo--visa">VISA</span>
              <span className="pay-logo pay-logo--mastercard">
                <span className="mastercard-mark" aria-hidden="true"><i /><i /></span>
                <span>Mastercard</span>
              </span>
              <span className="pay-logo pay-logo--ecocash">
                <span className="ecocash-mark"><span className="ecocash-eco">Eco</span><span className="ecocash-cash">Cash</span></span>
              </span>
            </span>
          </div>
        </div>
      </div>
    </footer>
  )
}