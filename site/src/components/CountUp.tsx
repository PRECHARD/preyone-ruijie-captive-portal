import { animate, useInView } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'

type CountUpProps = {
  value: number
  suffix?: string
  duration?: number
}

export function CountUp({ value, suffix = '', duration = 1.7 }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true, margin: '-40px' })
  const [display, setDisplay] = useState('0')

  useEffect(() => {
    if (!inView) return
    const controls = animate(0, value, {
      duration,
      ease: 'easeOut',
      onUpdate: (v) => setDisplay(Math.round(v).toLocaleString()),
    })
    return () => controls.stop()
  }, [inView, value, duration])

  return (
    <span ref={ref}>
      {display}
      <span className="text-gradient-cyan">{suffix}</span>
    </span>
  )
}