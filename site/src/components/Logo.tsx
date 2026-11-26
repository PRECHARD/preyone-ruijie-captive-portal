type LogoProps = {
  size?: number
  wordmark?: boolean
  className?: string
}

/**
 * The supplied landing-page wordmark is a deep purple mark, so on the neon
 * dark nav it sits on a small white chip — the same refined plate used on the
 * invoice sign-in. That keeps the exact brand artwork legible without
 * recolouring the trademark.
 */
export function Logo({ size = 44, wordmark = true, className }: LogoProps) {
  return (
    <div className={`flex items-center ${wordmark ? 'gap-3' : 'justify-center'} ${className ?? ''}`}>
      <span className="inline-flex items-center justify-center rounded-lg bg-white/95 px-2 py-1 shadow-[0_4px_16px_rgba(0,0,0,0.3)] ring-1 ring-white/40">
        <img
          src="/images/landingpage-1000.png"
          alt="Preyone"
          width={1000}
          height={423}
          className="shrink-0 object-contain"
          style={{ height: `${size}px`, width: 'auto' }}
        />
      </span>
    </div>
  )
}
