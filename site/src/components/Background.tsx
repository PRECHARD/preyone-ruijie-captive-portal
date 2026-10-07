export function Background() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="grid-overlay absolute inset-0" />
      <div className="animate-blob absolute -top-44 -left-32 h-[38rem] w-[38rem] rounded-full bg-[#6a0dad]/20 blur-[120px]" />
      <div className="animate-blob-alt absolute top-1/3 -right-40 h-[34rem] w-[34rem] rounded-full bg-[#ff00ff]/12 blur-[120px]" />
      <div className="animate-blob-3 absolute -bottom-52 left-1/4 h-[36rem] w-[36rem] rounded-full bg-[#00d4ff]/12 blur-[130px]" />
      <div className="noise absolute inset-0" />
    </div>
  )
}