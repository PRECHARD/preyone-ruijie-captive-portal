type SectionHeadingProps = {
  label: string
  title: string
  desc?: string
  align?: 'center' | 'left'
}

export function SectionHeading({ label, title, desc, align = 'center' }: SectionHeadingProps) {
  const alignCls = align === 'center' ? 'text-center items-center' : 'text-left items-start'
  return (
    <div className={`flex flex-col gap-3 ${alignCls} mb-10 sm:mb-14`}>
      <span className="chip">{label}</span>
      <h2 className="text-gradient font-display text-4xl leading-none tracking-wide sm:text-5xl lg:text-6xl">
        {title}
      </h2>
      {desc && <p className={`max-w-2xl text-sm leading-relaxed text-slate-400 sm:text-base ${align === 'center' ? 'mx-auto' : ''}`}>{desc}</p>}
    </div>
  )
}