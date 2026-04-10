import { useState, useRef, useEffect } from 'react';
import QuoteForm, { EMPTY_QUOTE } from './QuoteForm';
import { searchPipeline } from '../api';

const EMPTY_CUSTOMER = {
  company_name: '', contact_person: '', phone: '',
  source: 'cold_call', industry: '', interaction_type: 'contacted',
  needs: '', notes: '', next_action: '', follow_up_date: '',
  quotes: [],
};

export { EMPTY_CUSTOMER };

const SOURCE_OPTIONS = [
  { value: 'cold_call', label: '📞 Cold Call' },
  { value: 'zalo_facebook', label: '💬 Zalo/Facebook' },
  { value: 'referral', label: '🤝 Referral' },
  { value: 'email', label: '📧 Email' },
  { value: 'direct', label: '🤝 Gặp trực tiếp' },
  { value: 'other', label: '💡 Khác' },
];

export default function CustomerForm({ customer, onChange, onRemove, index }) {
  const c = customer;
  const set = (field, value) => onChange({ ...c, [field]: value });
  const customerType = c._type || 'new';

  const addQuote = () => set('quotes', [...(c.quotes || []), { ...EMPTY_QUOTE }]);
  const updateQuote = (i, q) => {
    const quotes = [...(c.quotes || [])];
    quotes[i] = q;
    set('quotes', quotes);
  };
  const removeQuote = (i) => set('quotes', (c.quotes || []).filter((_, idx) => idx !== i));

  // Search state (for existing customer type)
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [defaultCustomers, setDefaultCustomers] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const searchTimer = useRef(null);
  const dropdownRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleFocus = async () => {
    try {
      const results = await searchPipeline('');
      console.log('[Pipeline search] focus results:', results?.length, results);
      setDefaultCustomers(results);
    } catch (err) {
      console.error('[Pipeline search] focus error:', err);
    }
    if (searchQuery.length < 2) setShowDropdown(true);
  };

  const handleSearchInput = (query) => {
    setSearchQuery(query);
    clearTimeout(searchTimer.current);
    if (query.length < 2) {
      setSearchResults([]);
      setShowDropdown(true); // show defaults
      return;
    }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const results = await searchPipeline(query);
        setSearchResults(results);
        setShowDropdown(true);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 300);
  };

  const displayResults = searchQuery.length >= 2 ? searchResults : defaultCustomers;

  const selectExisting = (existing) => {
    onChange({
      ...EMPTY_CUSTOMER,
      _type: 'existing',
      _existingId: existing.id,
      company_name: existing.company_name,
      contact_person: existing.contact_person || '',
      phone: existing.phone || '',
      industry: existing.industry || '',
      source: existing.source || 'cold_call',
      quotes: [],
    });
    setShowDropdown(false);
  };

  const clearExisting = () => {
    onChange({
      _type: 'existing',
      _existingId: null,
      company_name: '', contact_person: '', phone: '',
      source: 'cold_call', industry: '', interaction_type: 'contacted',
      needs: '', notes: '', next_action: '', follow_up_date: '',
      quotes: [],
    });
    setSearchQuery('');
    setSearchResults([]);
    setShowDropdown(false);
  };

  const hasCustomerInfo = customerType === 'new' || (customerType === 'existing' && c._existingId);

  return (
    <div style={{
      background: 'var(--bg-card)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius)',
      padding: 20,
      marginBottom: 16,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h4 style={{ fontSize: 15, fontFamily: 'var(--font-display)', display: 'flex', alignItems: 'center', gap: 8 }}>
          Khách hàng #{index + 1}
          {c.company_name && <span style={{ color: 'var(--primary)' }}>— {c.company_name}</span>}
          {customerType === 'existing' && (
            <span style={{
              fontSize: 11, background: '#dbeafe', color: '#1d4ed8',
              borderRadius: 4, padding: '2px 7px', fontWeight: 600,
            }}>
              Khách cũ
            </span>
          )}
        </h4>
        {onRemove && (
          <button type="button" className="btn btn-danger btn-sm" onClick={onRemove}>Xóa khách</button>
        )}
      </div>

      {/* === EXISTING CUSTOMER: Search section === */}
      {customerType === 'existing' && !c._existingId && (
        <div ref={dropdownRef} style={{ position: 'relative', marginBottom: 16 }}>
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Tìm kiếm khách hàng cũ *</label>
            <div style={{ position: 'relative' }}>
              <input
                className="form-input"
                placeholder="Nhập tên công ty để tìm kiếm..."
                value={searchQuery}
                onChange={e => handleSearchInput(e.target.value)}
                onFocus={handleFocus}
                autoFocus
              />
              {searching && (
                <span className="spinner" style={{
                  width: 14, height: 14, position: 'absolute', right: 12, top: '50%', marginTop: -7,
                }} />
              )}
            </div>
          </div>
          {showDropdown && displayResults.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200,
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', boxShadow: '0 4px 16px rgba(0,0,0,0.12)',
              maxHeight: 320, overflowY: 'auto', marginTop: 4,
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '8px 14px 4px',
              }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                  {searchQuery.length < 2 ? 'Khách hàng gần đây' : 'Kết quả tìm kiếm'}
                </span>
                {defaultCustomers.length > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text-2)' }}>
                    {displayResults.length} / {defaultCustomers.length} khách hàng
                  </span>
                )}
              </div>
              {displayResults.map(r => (
                <button
                  key={r.id}
                  type="button"
                  onMouseDown={() => selectExisting(r)}
                  style={{
                    display: 'block', width: '100%', padding: '10px 14px',
                    background: 'none', border: 'none', borderBottom: '1px solid var(--border)',
                    textAlign: 'left', cursor: 'pointer', fontFamily: 'var(--font)',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = '#f0f7ff'}
                  onMouseLeave={e => e.currentTarget.style.background = 'none'}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>{r.company_name}</span>
                    {r.stage && (() => {
                      const stageInfo = { new: ['🆕','#3b82f6'], dormant: ['😴','#6b7280'], following: ['🔄','#f59e0b'], booked: ['✅','#10b981'] }[r.stage];
                      return stageInfo ? (
                        <span style={{ fontSize: 11, color: stageInfo[1], fontWeight: 600 }}>{stageInfo[0]}</span>
                      ) : null;
                    })()}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 3 }}>
                    {r.contact_person && <span style={{ marginRight: 10 }}>👤 {r.contact_person}</span>}
                    {r.phone && <span style={{ marginRight: 10 }}>📞 {r.phone}</span>}
                    {r.industry && <span style={{ marginRight: 10 }}>🏭 {r.industry}</span>}
                    {r.last_activity_date && (
                      <span style={{ color: 'var(--primary)', fontWeight: 500 }}>
                        Lần cuối: {new Date(r.last_activity_date).toLocaleDateString('vi-VN')}
                      </span>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {showDropdown && displayResults.length === 0 && !searching && searchQuery.length >= 2 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200,
              background: 'var(--bg-card)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: '12px 14px', marginTop: 4,
              fontSize: 13, color: 'var(--text-2)',
            }}>
              Không tìm thấy khách hàng nào với tên "{searchQuery}"
            </div>
          )}
        </div>
      )}

      {/* === EXISTING CUSTOMER: Readonly info panel === */}
      {customerType === 'existing' && c._existingId && (
        <div style={{
          background: '#f0f7ff', border: '1px solid #bfdbfe',
          borderRadius: 10, padding: '12px 16px', marginBottom: 16,
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text)', marginBottom: 4 }}>
              {c.company_name}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-2)', display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
              {c.contact_person && <span>👤 {c.contact_person}</span>}
              {c.phone && <span>📞 {c.phone}</span>}
              {c.industry && <span>🏭 {c.industry}</span>}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={clearExisting}
            style={{ marginLeft: 12, whiteSpace: 'nowrap', flexShrink: 0 }}
          >
            Đổi khách
          </button>
        </div>
      )}

      {/* === NEW CUSTOMER: Basic info form === */}
      {customerType === 'new' && (
        <div className="grid-3" style={{ gap: 12, marginBottom: 12 }}>
          <div className="form-group">
            <label className="form-label">Tên công ty *</label>
            <input className="form-input" placeholder="Công ty TNHH..." required value={c.company_name} onChange={e => set('company_name', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Người liên hệ</label>
            <input className="form-input" placeholder="Anh Minh, Chị Lan..." value={c.contact_person} onChange={e => set('contact_person', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Số điện thoại</label>
            <input className="form-input" placeholder="09xx xxx xxx" value={c.phone} onChange={e => set('phone', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Nguồn</label>
            <select className="form-select" value={c.source} onChange={e => set('source', e.target.value)}>
              {SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Ngành hàng</label>
            <input className="form-input" placeholder="Dệt may, điện tử, gỗ..." value={c.industry} onChange={e => set('industry', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Follow up date</label>
            <input type="date" className="form-input" value={c.follow_up_date} onChange={e => set('follow_up_date', e.target.value)} />
          </div>
        </div>
      )}

      {/* === Interaction fields (shown once customer is identified) === */}
      {hasCustomerInfo && (
        <>
          {/* Follow up date for existing customer */}
          {customerType === 'existing' && (
            <div style={{ marginBottom: 12 }}>
              <div className="form-group" style={{ maxWidth: 220 }}>
                <label className="form-label">Follow up date</label>
                <input type="date" className="form-input" value={c.follow_up_date} onChange={e => set('follow_up_date', e.target.value)} />
              </div>
            </div>
          )}

          {/* Interaction type */}
          <div className="form-group" style={{ marginBottom: 16 }}>
            <label className="form-label">Trạng thái tương tác *</label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {[
                { key: 'saved', label: '📌 Lưu liên hệ', sub: 'Chưa liên hệ được' },
                { key: 'contacted', label: '📞 Đã liên hệ', sub: 'Chưa báo giá' },
                { key: 'quoted', label: '📋 Đã báo giá', sub: 'Có báo giá' },
              ].map(t => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => set('interaction_type', t.key)}
                  style={{
                    padding: '10px 16px', borderRadius: 10, cursor: 'pointer',
                    background: c.interaction_type === t.key ? 'var(--primary-dim)' : 'transparent',
                    border: `1px solid ${c.interaction_type === t.key ? 'var(--primary)' : 'var(--border)'}`,
                    color: c.interaction_type === t.key ? 'var(--primary)' : 'var(--text-2)',
                    textAlign: 'left', fontFamily: 'var(--font)',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{t.label}</div>
                  <div style={{ fontSize: 11, marginTop: 2 }}>{t.sub}</div>
                </button>
              ))}
            </div>
          </div>

          {/* Notes */}
          <div className="grid-2" style={{ gap: 12, marginBottom: 12 }}>
            {c.interaction_type !== 'saved' && (
              <div className="form-group">
                <label className="form-label">Nhu cầu khách</label>
                <textarea className="form-textarea" rows={2} placeholder="Nhu cầu vận chuyển, hàng hóa, route..." value={c.needs} onChange={e => set('needs', e.target.value)} />
              </div>
            )}
            <div className="form-group">
              <label className="form-label">Ghi chú</label>
              <textarea className="form-textarea" rows={2} placeholder="Thông tin bổ sung, tình trạng trao đổi..." value={c.notes} onChange={e => set('notes', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Hành động tiếp theo</label>
              <textarea className="form-textarea" rows={2} placeholder="Sẽ gọi lại, gửi báo giá, đặt lịch gặp..." value={c.next_action} onChange={e => set('next_action', e.target.value)} />
            </div>
          </div>

          {/* Quotes section */}
          {c.interaction_type === 'quoted' && (
            <div>
              <div className="divider" />
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
                <div className="section-title" style={{ margin: 0 }}>
                  Báo giá ({(c.quotes || []).length})
                </div>
                <button type="button" className="btn btn-ghost btn-sm" onClick={addQuote}>
                  + Thêm báo giá
                </button>
              </div>

              {(c.quotes || []).length === 0 ? (
                <div style={{
                  border: '1px dashed var(--border)', borderRadius: 10,
                  padding: '20px', textAlign: 'center', color: 'var(--text-2)', fontSize: 13,
                }}>
                  Chưa có báo giá.{' '}
                  <button type="button" onClick={addQuote} style={{ color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13 }}>
                    Thêm ngay
                  </button>
                </div>
              ) : (
                (c.quotes || []).map((q, i) => (
                  <QuoteForm key={i} quote={q} index={i} onChange={(updated) => updateQuote(i, updated)} onRemove={() => removeQuote(i)} />
                ))
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
