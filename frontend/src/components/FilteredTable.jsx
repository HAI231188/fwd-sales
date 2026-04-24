import { useState, useRef, useEffect } from 'react';

const DROPDOWN = {
  position: 'absolute', top: '100%', left: 0, zIndex: 500,
  background: '#fff', border: '1px solid var(--border)', borderRadius: 8,
  boxShadow: '0 4px 16px rgba(0,0,0,0.15)', padding: 8, minWidth: 190,
};

function useClickOutside(ref, cb) {
  useEffect(() => {
    function h(e) { if (ref.current && !ref.current.contains(e.target)) cb(); }
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [cb]);
}

function TextFilter({ value, onApply, onClose }) {
  const ref = useRef();
  const [local, setLocal] = useState(value || '');
  useClickOutside(ref, onClose);
  return (
    <div ref={ref} style={DROPDOWN}>
      <input autoFocus value={local} placeholder="Tìm kiếm..."
        onChange={e => setLocal(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') { onApply(local); onClose(); }
          if (e.key === 'Escape') onClose();
        }}
        style={{ width: '100%', padding: '5px 8px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 12, marginBottom: 6, boxSizing: 'border-box' }}
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="btn btn-primary btn-sm" style={{ flex: 1, fontSize: 11 }}
          onClick={() => { onApply(local); onClose(); }}>Lọc</button>
        <button className="btn btn-ghost btn-sm" style={{ fontSize: 11 }}
          onClick={() => { onApply(''); onClose(); }}>Xóa</button>
      </div>
    </div>
  );
}

function SelectFilter({ options, value, onApply, onClose }) {
  const ref = useRef();
  useClickOutside(ref, onClose);
  const itemStyle = (active) => ({
    padding: '6px 8px', cursor: 'pointer', borderRadius: 4, fontSize: 12,
    color: active ? 'var(--primary)' : 'var(--text)',
    fontWeight: active ? 600 : 400,
    background: active ? 'rgba(34,197,94,0.08)' : 'transparent',
  });
  return (
    <div ref={ref} style={{ ...DROPDOWN, minWidth: 160 }}>
      <div style={itemStyle(!value)} onClick={() => { onApply(''); onClose(); }}>Tất cả</div>
      {(options || []).map(opt => (
        <div key={opt.value} style={itemStyle(value === opt.value)}
          onClick={() => { onApply(opt.value); onClose(); }}>
          {opt.label}
        </div>
      ))}
    </div>
  );
}

// columns: [{ key, label, filterType?: 'text'|'select', options?: [{value,label}], accessor?: row=>string }]
// data: array of row objects
// renderRow: (row, index) => <tr>
// extraHeaderCells: optional <th> elements appended after columns (e.g. action column)
export default function FilteredTable({
  columns,
  data,
  renderRow,
  emptyText = 'Không có job nào',
  extraHeaderCells,
  tableStyle,
}) {
  const [filters, setFilters] = useState({});
  const [openFilter, setOpenFilter] = useState(null);

  const filteredData = data.filter(row =>
    columns.every(col => {
      if (!col.filterType) return true;
      const fv = filters[col.key];
      if (!fv) return true;
      const val = col.accessor ? String(col.accessor(row) ?? '') : String(row[col.key] ?? '');
      if (col.filterType === 'select') return val === String(fv);
      return val.toLowerCase().includes(fv.toLowerCase());
    })
  );

  const hasFilters = columns.some(col => !!filters[col.key]);

  function clearAll() { setFilters({}); }
  function setFilter(key, val) {
    setFilters(prev => {
      const next = { ...prev };
      if (val) next[key] = val; else delete next[key];
      return next;
    });
  }

  const colCount = columns.length + (extraHeaderCells ? 1 : 0);

  return (
    <>
      {hasFilters && (
        <div style={{ padding: '6px 12px', background: 'rgba(34,197,94,0.06)', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 11, color: 'var(--text-2)' }}>
            Lọc: <strong>{filteredData.length}</strong>/{data.length} kết quả
          </span>
          <button className="btn btn-ghost btn-sm" style={{ fontSize: 11, padding: '2px 8px' }} onClick={clearAll}>
            ✕ Xóa tất cả lọc
          </button>
        </div>
      )}
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, ...tableStyle }}>
        <thead>
          <tr style={{ background: 'var(--bg)', borderBottom: '2px solid var(--border)' }}>
            {columns.map(col => {
              const active = !!filters[col.key];
              const isOpen = openFilter === col.key;
              return (
                <th key={col.key} style={{ padding: '10px 8px', textAlign: 'left', fontWeight: 600, color: active ? 'var(--primary)' : 'var(--text-2)', fontSize: 11, whiteSpace: 'nowrap', position: 'relative' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                    <span>{col.label}</span>
                    {col.filterType && (
                      <button onClick={e => { e.stopPropagation(); setOpenFilter(isOpen ? null : col.key); }}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '1px 3px', display: 'flex', alignItems: 'center' }}>
                        <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: active ? 'var(--primary)' : '#d1d5db', flexShrink: 0 }} />
                      </button>
                    )}
                  </div>
                  {isOpen && col.filterType === 'text' && (
                    <TextFilter value={filters[col.key]} onApply={v => setFilter(col.key, v)} onClose={() => setOpenFilter(null)} />
                  )}
                  {isOpen && col.filterType === 'select' && (
                    <SelectFilter options={col.options} value={filters[col.key]} onApply={v => setFilter(col.key, v)} onClose={() => setOpenFilter(null)} />
                  )}
                </th>
              );
            })}
            {extraHeaderCells}
          </tr>
        </thead>
        <tbody>
          {filteredData.length === 0 && (
            <tr>
              <td colSpan={colCount} style={{ textAlign: 'center', padding: 40, color: 'var(--text-3)' }}>
                {hasFilters ? 'Không có kết quả phù hợp với bộ lọc' : emptyText}
              </td>
            </tr>
          )}
          {filteredData.map((row, i) => renderRow(row, i))}
        </tbody>
      </table>
    </>
  );
}
