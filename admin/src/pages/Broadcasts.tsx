import { useState, useEffect, useCallback } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import Spinner from '../components/Spinner';
import EmptyState from '../components/EmptyState';
import Modal from '../components/Modal';

export default function Broadcasts() {
  const { user } = useAuth();
  const isCEO = user?.role === 'CEO';
  const [broadcasts, setBroadcasts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSend, setShowSend] = useState(false);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [msg, setMsg] = useState('');

  const fetch = useCallback(async () => {
    try { setBroadcasts(await api.get('/broadcasts')); } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetch(); const t = setInterval(fetch, 30000); return () => clearInterval(t); }, [fetch]);

  const sendBroadcast = async () => {
    setMsg('');
    try {
      await api.post('/broadcast', { title, message });
      setShowSend(false); setTitle(''); setMessage('');
      setMsg('Broadcast sent');
      fetch();
    } catch (e: any) { setMsg(e.message); }
  };

  const markRead = async (id: string) => {
    await api.post(`/broadcasts/${id}/read`);
    fetch();
  };

  const markAllRead = async () => {
    await api.post('/broadcasts/read-all');
    fetch();
  };

  if (loading) return <Spinner />;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h2 className="page-title">Broadcasts</h2>
          <p className="page-desc">{broadcasts.length} broadcast(s)</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {broadcasts.some((b: any) => b.is_unread) && (
            <button className="btn-secondary" onClick={markAllRead}>Mark All Read</button>
          )}
          {isCEO && <button className="btn-primary" onClick={() => setShowSend(true)}>Send Broadcast</button>}
        </div>
      </div>

      {msg && (
        <div className="form-status form-status--success" style={{ marginBottom: 16 }}>
          {msg}
        </div>
      )}

      {broadcasts.length === 0 ? (
        <EmptyState icon="📢" title="No Broadcasts" message="No broadcasts have been sent yet." />
      ) : (
        <div className="card">
          {broadcasts.map((b: any) => (
            <div key={b.id} className="alert-row" style={{ opacity: b.is_unread ? 1 : 0.55 }}>
              <div style={{ flex: 1 }}>
                <div className="alert-title">
                  {b.title}
                  {b.is_unread && <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--purple-glow)', marginLeft: 8 }} />}
                </div>
                {b.message && <div className="alert-msg">{b.message}</div>}
                <div className="alert-meta">
                  <span>{b.created_at ? new Date(b.created_at).toLocaleString() : ''}</span>
                  {b.sender_name && <span>by {b.sender_name}</span>}
                </div>
              </div>
              {b.is_unread && (
                <button className="btn-sm btn-approve" onClick={() => markRead(b.id)}>Mark Read</button>
              )}
            </div>
          ))}
        </div>
      )}

      <Modal open={showSend} onClose={() => setShowSend(false)} title="Send Broadcast">
        <div className="auth-form">
          <div className="auth-field"><label>Title</label><input value={title} onChange={e => setTitle(e.target.value)} placeholder="Broadcast title" /></div>
          <div className="auth-field"><label>Message</label><textarea value={message} onChange={e => setMessage(e.target.value)} placeholder="Your message..." style={{ minHeight: 100, resize: 'vertical', background: 'var(--surface2)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: 6, padding: 10, fontFamily: 'var(--font-body)', fontSize: 13 }} /></div>
          <button className="auth-btn" onClick={sendBroadcast}>Send to All Admins</button>
        </div>
      </Modal>
    </div>
  );
}
