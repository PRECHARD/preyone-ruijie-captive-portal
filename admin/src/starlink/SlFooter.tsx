import { FiGlobe, FiMail, FiMapPin, FiPhone, FiShield } from 'react-icons/fi';

export default function SlFooter() {
  return (
    <footer className="sl-ft">
      <div className="sl-ft-grid">
        <div className="sl-ft-col sl-ft-brand">
          <a href="https://preyone.com" target="_blank" rel="noopener noreferrer" aria-label="Preyone home">
            <img src="/images/preyonelogomainzw.png" alt="Preyone" className="sl-ft-mark" width={2048} height={1140} loading="lazy" decoding="async" />
          </a>
          <p className="sl-ft-tagline">
            High-speed satellite connectivity across Zimbabwe. Powered by Starlink Business
            Priority infrastructure.
          </p>
        </div>

        <div className="sl-ft-col">
          <h3>Get in touch</h3>
          <div className="sl-ft-cards">
            <a href="mailto:support@preyone.com" className="sl-ft-card">
              <span className="sl-ft-icon"><FiMail /></span>
              <span><span className="sl-ft-label">Email</span><span className="sl-ft-value">support@preyone.com</span></span>
            </a>
            <a href="tel:+263771327202" className="sl-ft-card">
              <span className="sl-ft-icon"><FiPhone /></span>
              <span><span className="sl-ft-label">Call us</span><span className="sl-ft-value">+263 771 327 202</span></span>
            </a>
            <div className="sl-ft-card">
              <span className="sl-ft-icon"><FiMapPin /></span>
              <span><span className="sl-ft-label">Location</span><span className="sl-ft-value">Harare, Zimbabwe</span></span>
            </div>
          </div>
        </div>

        <div className="sl-ft-col">
          <h3>Quick links</h3>
          <ul className="sl-ft-links">
            <li><a href="https://preyone.com" target="_blank" rel="noopener noreferrer"><FiGlobe /> Main website</a></li>
            <li><a href="/starlink-privacy.html"><FiShield /> Privacy policy</a></li>
          </ul>
        </div>
      </div>

      <div className="sl-ft-bottom">
        <span>© {new Date().getFullYear()} Preyone Enterprises (Pvt) Ltd. All rights reserved.</span>
        <span>Billing in USD · Preyone Payment</span>
      </div>
    </footer>
  );
}
