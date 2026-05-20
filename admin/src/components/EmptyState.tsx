export default function EmptyState({ icon = '📭', title, message }: { icon?: string; title: string; message?: string }) {
  return (
    <div style={{ padding: '60px 20px', textAlign: 'center', color: 'var(--text-muted)' }}>
      <div style={{ fontSize: 40, marginBottom: 12 }}>{icon}</div>
      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: '1.1rem', letterSpacing: 1, marginBottom: 6, color: 'var(--text)' }}>{title}</h3>
      {message && <p style={{ fontSize: 13 }}>{message}</p>}
    </div>
  );
}
