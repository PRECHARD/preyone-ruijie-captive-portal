import { useEffect, useState } from 'react';
import { api, type Product } from '../api';


export default function SparesSearch() {
  const [oem, setOem] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [brand, setBrand] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Product[]>([]);
  const [loading, setLoading] = useState(false);

  const search = async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = {};
      if (q) params.q = q;
      if (oem) params.oem = oem;
      if (make) params.make = make;
      if (model) params.model = model;
      if (year) params.year = year;
      if (brand) params.brand = brand;
      const r = Object.keys(params).length ? await api.productsSearch(params) : await api.products();
      setRows(r);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { search(); }, []);

  return (
    <div className="panel">
      <h2>Auto Spares Search</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
        <input placeholder="Free text" value={q} onChange={(e) => setQ(e.target.value)} />
        <input placeholder="OEM part number" value={oem} onChange={(e) => setOem(e.target.value)} />
        <input placeholder="Make" value={make} onChange={(e) => setMake(e.target.value)} />
        <input placeholder="Model" value={model} onChange={(e) => setModel(e.target.value)} />
        <input placeholder="Year" value={year} onChange={(e) => setYear(e.target.value)} />
        <input placeholder="Brand" value={brand} onChange={(e) => setBrand(e.target.value)} />
      </div>
      <button className="primary-btn" onClick={search} disabled={loading}>{loading ? 'Searching…' : 'Search'}</button>
      <table style={{ width: '100%', marginTop: 12, borderCollapse: 'collapse' }}>
        <thead><tr><th>Name</th><th>OEM</th><th>Make/Model/Year</th><th>Brand</th><th>Bin</th><th>Price</th><th>Stock</th></tr></thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.oem_part_number || '—'}</td>
              <td>{[p.make, p.model, p.year_from && p.year_to ? `${p.year_from}-${p.year_to}` : ''].filter(Boolean).join(' ') || '—'}</td>
              <td>{p.brand || '—'}</td>
              <td>{p.bin_location || '—'}</td>
              <td>{(`$${(Number(p.price) || 0).toFixed(2)}`)}</td>
              <td>{p.track_stock ? p.stock_qty : 'service'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
