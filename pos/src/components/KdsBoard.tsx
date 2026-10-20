import { useEffect, useState } from 'react';
import { api } from '../api';

const elapsedColor = (createdAt: string) => {
  const mins = (Date.now() - new Date(createdAt).getTime()) / 60000;
  if (mins < 5) return '#2ecc71';
  if (mins < 10) return '#f1c40f';
  return '#e74c3c';
};

export default function KdsBoard({ notify }: { notify: (m: string, k?: 'ok' | 'error') => void }) {
  const [tickets, setTickets] = useState<any[]>([]);
  const [status, setStatus] = useState('open');

  const load = async () => {
    try {
      const r = await api.kdsTickets(status);
      setTickets(r);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, [status]);

  const bump = async (id: string, next: string) => {
    try {
      await api.bumpKds(id, next);
      await load();
    } catch (e) {
      notify(e instanceof Error ? e.message : 'Bump failed', 'error');
    }
  };

  return (
    <div className="panel">
      <h2>Kitchen Display (KDS)</h2>
      <div style={{ marginBottom: 12 }}>
        <button className="chip" onClick={() => setStatus('open')}>Open</button>
        <button className="chip" onClick={() => setStatus('all')}>All</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {tickets.map((t) => (
          <div key={t.id} style={{ border: `3px solid ${elapsedColor(t.created_at)}`, borderRadius: 8, padding: 10 }}>
            <div style={{ fontWeight: 700 }}>#{t.doc_number} · {t.station}</div>
            <div style={{ fontSize: '0.8rem', color: '#888' }}>{new Date(t.created_at).toLocaleTimeString()}</div>
            <ul style={{ margin: '6px 0', paddingLeft: 16 }}>
              {(t.items || []).map((it: any) => (
                <li key={it.id}>{Number(it.qty)}× {it.description}</li>
              ))}
            </ul>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="secondary-btn" onClick={() => bump(t.id, 'preparing')}>Preparing</button>
              <button className="secondary-btn" onClick={() => bump(t.id, 'ready')}>Ready</button>
              <button className="primary-btn" onClick={() => bump(t.id, 'bumped')}>Bump</button>
            </div>
          </div>
        ))}
        {tickets.length === 0 && <div className="empty-note">No tickets</div>}
      </div>
    </div>
  );
}
