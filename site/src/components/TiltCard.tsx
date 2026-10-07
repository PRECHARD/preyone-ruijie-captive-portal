import { motion, useMotionValue, useSpring, useTransform } from 'framer-motion'
import type { ReactNode } from 'react'

type TiltCardProps = {
  children: ReactNode
  className?: string
  max?: number
}

export function TiltCard({ children, className, max = 9 }: TiltCardProps) {
  const x = useMotionValue(0)
  const y = useMotionValue(0)
  const rotateX = useSpring(useTransform(y, [-0.5, 0.5], [max, -max]), { stiffness: 220, damping: 20 })
  const rotateY = useSpring(useTransform(x, [-0.5, 0.5], [-max, max]), { stiffness: 220, damping: 20 })

  return (
    <div className="tilt-wrap h-full">
      <motion.div
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect()
          x.set((e.clientX - rect.left) / rect.width - 0.5)
          y.set((e.clientY - rect.top) / rect.height - 0.5)
        }}
        onMouseLeave={() => {
          x.set(0)
          y.set(0)
        }}
        style={{ rotateX, rotateY, transformStyle: 'preserve-3d' }}
        className={className}
      >
        {children}
      </motion.div>
    </div>
  )
}