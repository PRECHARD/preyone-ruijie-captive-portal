import { useEffect, useState } from 'react';
import { api } from '../api';

export default function TableGrid({ notify }: { notify: (m: string, k?: 'ok' | 'error') => void }) {
  const [tables, setTables] = useState<any[]>([]);
  const [name, setName] = useState('');
  const [capacity, setCapacity] = useState('2');

  const load = async () => {
    try { setTables(await api.tables()); } catch (e) { console.error(e); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    if (!name.trim()) return;
    try {
      await api.createTable(name.trim(), Number(capacity) || 2);
      setName('');
      await load();
    } catch (e) { notify(e instanceof Error ? e.message : 'Create failed', 'error'); }
  };

  const setStatus = async (id: string, status: string) => {
    try { await api.updateTable(id, { status }); await load(); }
    catch (e) { notify(e instanceof Error ? e.message : 'Update failed', 'error'); }
  };

  const color = (s: string) => s === 'available' ? '#2ecc71' : s === 'occupied' ? '#e74c3c' : '#f1c40f';

  return (
    <div className="panel">
      <h2>Dine-in Tables</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input placeholder="Table name" value={name} onChange={(e) => setName(e.target.value)} />
        <input type="number" min="1" value={capacity} onChange={(e) => setCapacity(e.target.value)} style={{ width: 60 }} />
        <button className="primary-btn" onClick={create}>Add table</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(120px, 1fr))', gap: 10 }}>
        {tables.map((t) => (
          <div key={t.id} style={{ border: `2px solid ${color(t.status)}`, borderRadius: 8, padding: 10, textAlign: 'center' }}>
            <div style={{ fontWeight: 700 }}>{t.name}</div>
            <div style={{ fontSize: '0.8rem' }}>cap {t.capacity} · {t.status}</div>
            <div style={{ display: 'flex', gap: 4, justifyContent: 'center', marginTop: 6 }}>
              <button className="secondary-btn" onClick={() => setStatus(t.id, 'available')}>Free</button>
              <button className="secondary-btn" onClick={() => setStatus(t.id, 'occupied')}>Occ</button>
              <button className="secondary-btn" onClick={() => setStatus(t.id, 'reserved')}>Res</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
