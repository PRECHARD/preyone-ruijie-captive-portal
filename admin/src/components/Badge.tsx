const variants: Record<string, { bg: string; color: string }> = {
  active: { bg: 'rgba(0,230,118,0.15)', color: 'var(--green)' },
  inactive: { bg: 'rgba(255,23,68,0.15)', color: 'var(--red)' },
  pending: { bg: 'rgba(255,145,0,0.15)', color: 'var(--orange)' },
  approved: { bg: 'rgba(0,230,118,0.15)', color: 'var(--green)' },
  rejected: { bg: 'rgba(255,23,68,0.15)', color: 'var(--red)' },
  warning: { bg: 'rgba(255,145,0,0.15)', color: 'var(--orange)' },
  info: { bg: 'rgba(0,229,255,0.15)', color: 'var(--cyan)' },
  default: { bg: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' },
};

export default function Badge({ variant = 'default', children }: { variant?: string; children: React.ReactNode }) {
  const v = variants[variant] || variants.default;
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: '0.65rem', fontWeight: 600, textTransform: 'uppercase', background: v.bg, color: v.color }}>
      {children}
    </span>
  );
}
