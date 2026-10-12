import { useEffect, useState } from 'react';

// Live connectivity dot for the till: green when the browser has a cloud
// connection (sales can settle through Pesepay/webhooks), amber when offline.
export default function CloudSyncIndicator() {
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);

  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  return (
    <span className={`chip ${online ? 'ok' : 'warn'}`} title={online ? 'Connected' : 'Offline — check connection'}>
      <span className={`sync-dot${online ? '' : ' off'}`} /> {online ? 'SYNCED' : 'OFFLINE'}
    </span>
  );
}
