type LogoProps = {
  size?: number
  wordmark?: boolean
  className?: string
}

export function Logo({ size = 60, wordmark = true, className }: LogoProps) {
  return (
    <div className={`flex items-center ${wordmark ? 'gap-3' : 'justify-center'} ${className ?? ''}`}>
      <img
        src="/images/preyonenoneglow-logo-optimized.png"
        alt="Preyone"
        width={80}
        height={80}
        className="shrink-0 object-contain"
        style={{ height: `${size}px`, width: 'auto' }}
      />
    </div>
  )
}