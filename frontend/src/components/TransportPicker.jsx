import { useState, useEffect, useRef } from 'react';
import { getTransportCompanies } from '../api';
import TransportFormModal from './TransportFormModal';

// Picker-only UI — user MUST select from list. No free-text saved.
//
// Props:
//   value:    { transport_company_id, transport_name } (snapshot) | null
//   onChange: ({ transport_company_id, transport_name }) => void
//             — on clear: pass nulls for both
//   compact:  truthy → smaller for inline grid cells
//   placeholder: string for empty input
//   canCreate: boolean — show "+ Thêm vận tải mới" button. Default true.
export default function TransportPicker({ value, onChange, compact = false, placeholder = 'Chọn vận tải...', canCreate = true }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [showFormModal, setShowFormModal] = useState(false);
  const wrapperRef = useRef(null);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    getTransportCompanies(debounced)
      .then(rows => { if (!cancelled) setResults(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (!cancelled) setResults([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [debounced, open]);

  useEffect(() => {
    if (!open) return;
    const handler = e => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        if (!e.target.closest('[data-transport-form-modal]')) setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  function selectCompany(c) {
    onChange({ transport_company_id: c.id, transport_name: c.name });
    setOpen(false);
    setQuery('');
  }
  function clearSelection() {
    onChange({ transport_company_id: null, transport_name: null });
    setOpen(false);
    setQuery('');
  }
  function handleCreated(saved) {
    selectCompany(saved);
  }

  const hasSelection = !!(value && (value.transport_company_id || value.transport_name));
  const displayName = value?.transport_name || '';
  const isLegacy = hasSelection && !value.transport_company_id;

  const inputStyle = {
    width: '100%',
    padding: compact ? '2px 6px' : '5px 8px',
    border: '1px solid var(--border)',
    borderRadius: 4,
    fontSize: compact ? 12 : 13,
    background: '#fff',
  };

  return (
    <div ref={wrapperRef} style={{ position: 'relative', minWidth: compact ? 100 : 140 }}>
      {hasSelection ? (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: compact ? '2px 6px' : '4px 8px',
            background: isLegacy ? 'rgba(217,119,6,0.08)' : 'rgba(34,197,94,0.08)',
            border: `1px solid ${isLegacy ? 'rgba(217,119,6,0.3)' : 'rgba(34,197,94,0.3)'}`,
            borderRadius: 4, fontSize: compact ? 12 : 13,
          }}
          title={isLegacy ? 'Tên vận tải cũ chưa liên kết — click để chọn lại' : displayName}
          onClick={() => setOpen(true)}
        >
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'pointer' }}>
            {displayName}{isLegacy && <span style={{ fontSize: 10, color: 'var(--warning)', marginLeft: 4 }}>(cũ)</span>}
          </span>
          <button
            onClick={e => { e.stopPropagation(); clearSelection(); }}
            title="Xóa"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 0, fontSize: 14, lineHeight: 1 }}
          >×</button>
        </div>
      ) : (
        <input
          type="text"
          placeholder={placeholder}
          value={query}
          style={inputStyle}
          onChange={e => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
        />
      )}

      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200,
          background: '#fff', border: '1px solid var(--border)', borderRadius: 6,
          marginTop: 2, boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
          maxHeight: 240, overflowY: 'auto',
        }}>
          {loading && (
            <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-3)' }}>Đang tải...</div>
          )}
          {!loading && results.length === 0 && (
            <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--text-3)' }}>
              {debounced ? 'Không có vận tải nào khớp' : 'Gõ để tìm vận tải'}
            </div>
          )}
          {!loading && results.map(c => (
            <div key={c.id}
              onMouseDown={() => selectCompany(c)}
              style={{ padding: '8px 10px', cursor: 'pointer', borderBottom: '1px solid var(--border)', fontSize: 13 }}
              onMouseEnter={e => e.currentTarget.style.background = 'var(--bg)'}
              onMouseLeave={e => e.currentTarget.style.background = '#fff'}>
              <div style={{ fontWeight: 500 }}>{c.name}</div>
              {(c.contact_person || c.phone) && (
                <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  {c.contact_person || ''}{c.contact_person && c.phone ? ' · ' : ''}{c.phone || ''}
                </div>
              )}
            </div>
          ))}
          {canCreate && (
            <div
              onMouseDown={() => { setShowFormModal(true); setOpen(false); }}
              style={{ padding: '8px 10px', cursor: 'pointer', color: 'var(--info)', fontSize: 12, fontStyle: 'italic', borderTop: results.length > 0 ? '1px solid var(--border)' : 'none' }}
            >
              + Thêm vận tải mới{debounced ? ` "${debounced}"` : ''}
            </div>
          )}
        </div>
      )}

      {showFormModal && (
        <div data-transport-form-modal>
          <TransportFormModal
            initialName={debounced}
            onClose={() => setShowFormModal(false)}
            onSaved={handleCreated}
          />
        </div>
      )}
    </div>
  );
}
