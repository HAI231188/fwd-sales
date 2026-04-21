import { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getLogStaff, searchJobCustomers } from '../api';

const CONT_TYPES = ['20DC','40DC','40HC','45HC','20RF','40RF'];
const OTHER_SVC_KEYS = ['ktcl','kiem_dich','hun_trung','co','khac'];
const OTHER_SVC_LABEL = { ktcl:'KTCL', kiem_dich:'Kiểm dịch', hun_trung:'Hun trùng', co:'CO', khac:'Khác' };

const INIT_FORM = {
  job_code: '', customer_name: '', customer_address: '', customer_tax_code: '',
  sales_id: '', pol: '', pod: '', bill_number: '', cont_number: '', cont_type: '',
  seal_number: '', etd: '', eta: '', tons: '', cbm: '', deadline: '',
  service_type: 'tk', assignment_mode: 'auto', other_services: {},
};

export default function CreateJobModal({ onClose, onCreated }) {
  const { data: staff = [] } = useQuery({ queryKey: ['logStaff'], queryFn: getLogStaff });
  const salesStaff = staff.filter(s => s.role === 'sales' || s.role === 'lead');

  const [searchMode, setSearchMode] = useState('search');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [form, setForm] = useState(INIT_FORM);
  const [saving, setSaving] = useState(false);
  const searchRef = useRef();
  const timerRef = useRef();

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const toggleOs = k => setForm(f => ({ ...f, other_services: { ...f.other_services, [k]: !f.other_services[k] } }));
  const locked = !!selectedCustomer;

  useEffect(() => {
    if (searchMode !== 'search' || !searchQuery.trim()) {
      setSearchResults([]); setShowDropdown(false); return;
    }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      try {
        const results = await searchJobCustomers(searchQuery);
        setSearchResults(results);
        setShowDropdown(results.length > 0);
      } catch { setSearchResults([]); setShowDropdown(false); }
    }, 300);
    return () => clearTimeout(timerRef.current);
  }, [searchQuery, searchMode]);

  function selectCustomer(c) {
    setSelectedCustomer(c);
    setSearchQuery(c.customer_name);
    setShowDropdown(false);
    setForm(f => ({
      ...f,
      customer_name: c.customer_name,
      customer_address: c.customer_address || '',
      customer_tax_code: c.customer_tax_code || '',
      sales_id: c.sales_id ? String(c.sales_id) : f.sales_id,
    }));
  }

  function clearSelection() {
    setSelectedCustomer(null);
    setSearchQuery('');
    setForm(f => ({ ...f, customer_name: '', customer_address: '', customer_tax_code: '', sales_id: '' }));
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  function switchToNew() {
    setSearchMode('new');
    setSelectedCustomer(null);
    setShowDropdown(false);
    setSearchQuery('');
  }

  function switchToSearch() {
    setSearchMode('search');
    setSelectedCustomer(null);
    setSearchQuery('');
    setForm(f => ({ ...f, customer_name: '', customer_address: '', customer_tax_code: '', sales_id: '' }));
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  async function submit() {
    if (!form.customer_name || !form.service_type) return;
    setSaving(true);
    try {
      await onCreated({
        ...form,
        customer_id: selectedCustomer?.customer_id || null,
        sales_id: form.sales_id || null,
        tons: form.tons ? Number(form.tons) : null,
        cbm: form.cbm ? Number(form.cbm) : null,
        deadline: form.deadline || null,
        etd: form.etd || null,
        eta: form.eta || null,
        is_new_customer: searchMode === 'new',
      });
      onClose();
    } finally { setSaving(false); }
  }

  return (
    <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-lg" style={{ maxHeight: '92vh' }}>
        <div className="modal-header">
          <h3>Tạo Job Mới</h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="grid-2" style={{ gap: 12 }}>
            <div className="form-group">
              <label className="form-label">Mã Job</label>
              <input className="form-input" value={form.job_code} onChange={e => set('job_code', e.target.value)} placeholder="VD: SLB-2024-001" />
            </div>
            <div className="form-group">
              <label className="form-label">Loại dịch vụ *</label>
              <select className="form-select" value={form.service_type} onChange={e => set('service_type', e.target.value)}>
                <option value="tk">Tờ khai (TK)</option>
                <option value="truck">Vận chuyển (Truck)</option>
                <option value="both">TK + Vận chuyển</option>
              </select>
            </div>
          </div>

          {/* Customer search / new toggle */}
          <div style={{ marginTop: 12, padding: 12, background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginRight: 4 }}>Khách hàng</span>
              <button type="button" className={`btn btn-sm ${searchMode === 'search' ? 'btn-primary' : 'btn-ghost'}`}
                style={{ padding: '2px 10px', fontSize: 11 }} onClick={switchToSearch}>
                Tìm khách cũ
              </button>
              <button type="button" className={`btn btn-sm ${searchMode === 'new' ? 'btn-primary' : 'btn-ghost'}`}
                style={{ padding: '2px 10px', fontSize: 11 }} onClick={switchToNew}>
                Khách mới
              </button>
            </div>

            {searchMode === 'search' ? (
              <div style={{ position: 'relative' }}>
                {selectedCustomer ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', background: 'var(--primary-dim)', borderRadius: 6 }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{selectedCustomer.customer_name}</div>
                      {selectedCustomer.contact_person && (
                        <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
                          {selectedCustomer.contact_person}{selectedCustomer.phone ? ` · ${selectedCustomer.phone}` : ''}
                        </div>
                      )}
                    </div>
                    <button type="button" className="btn btn-ghost btn-sm btn-icon" title="Bỏ chọn" onClick={clearSelection}>✕</button>
                  </div>
                ) : (
                  <>
                    <input ref={searchRef} className="form-input"
                      placeholder="Tìm tên công ty (khách đã booked)..."
                      value={searchQuery}
                      onChange={e => {
                        setSearchQuery(e.target.value);
                        if (!e.target.value) { setSearchResults([]); setShowDropdown(false); }
                      }}
                      onFocus={() => searchResults.length > 0 && setShowDropdown(true)}
                      onBlur={() => setTimeout(() => setShowDropdown(false), 200)}
                    />
                    {showDropdown && (
                      <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid var(--border)', borderRadius: 8, zIndex: 200, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', maxHeight: 240, overflowY: 'auto' }}>
                        {searchResults.map(c => (
                          <div key={c.pipeline_id} onMouseDown={() => selectCustomer(c)}
                            style={{ padding: '10px 14px', cursor: 'pointer', borderBottom: '1px solid var(--border)' }}>
                            <div style={{ fontWeight: 600, fontSize: 13 }}>{c.customer_name}</div>
                            <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
                              {c.contact_person && `${c.contact_person} · `}{c.phone && `${c.phone} · `}Sales: {c.sales_name || '—'}
                            </div>
                          </div>
                        ))}
                        {searchQuery && (
                          <div onMouseDown={switchToNew}
                            style={{ padding: '10px 14px', cursor: 'pointer', color: 'var(--info)', fontSize: 12, fontStyle: 'italic' }}>
                            + Thêm khách mới "{searchQuery}"
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Tên khách hàng *</label>
                <input className="form-input" value={form.customer_name}
                  onChange={e => set('customer_name', e.target.value)}
                  placeholder="Tên công ty..." autoFocus />
              </div>
            )}
          </div>

          {/* Customer details */}
          <div className="grid-2" style={{ gap: 12, marginTop: 12 }}>
            <div className="form-group">
              <label className="form-label">MST</label>
              <input className="form-input" value={form.customer_tax_code}
                readOnly={locked} style={locked ? { background: 'var(--bg)', cursor: 'default' } : {}}
                onChange={e => !locked && set('customer_tax_code', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Sales phụ trách</label>
              <select className="form-select" value={form.sales_id}
                disabled={locked} onChange={e => set('sales_id', e.target.value)}>
                <option value="">-- Chọn --</option>
                {salesStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
          <div className="form-group" style={{ marginTop: 12 }}>
            <label className="form-label">Địa chỉ</label>
            <input className="form-input" value={form.customer_address}
              readOnly={locked} style={locked ? { background: 'var(--bg)', cursor: 'default' } : {}}
              onChange={e => !locked && set('customer_address', e.target.value)} />
          </div>

          {/* Shipment */}
          <div className="grid-2" style={{ gap: 12, marginTop: 12 }}>
            <div className="form-group">
              <label className="form-label">POL</label>
              <input className="form-input" value={form.pol} onChange={e => set('pol', e.target.value)} placeholder="Cảng xếp hàng" />
            </div>
            <div className="form-group">
              <label className="form-label">POD</label>
              <input className="form-input" value={form.pod} onChange={e => set('pod', e.target.value)} placeholder="Cảng dỡ hàng" />
            </div>
          </div>
          <div className="grid-2" style={{ gap: 12, marginTop: 12 }}>
            <div className="form-group">
              <label className="form-label">Số Cont</label>
              <input className="form-input" value={form.cont_number} onChange={e => set('cont_number', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Loại Cont</label>
              <select className="form-select" value={form.cont_type} onChange={e => set('cont_type', e.target.value)}>
                <option value="">-- Chọn --</option>
                {CONT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <div className="grid-2" style={{ gap: 12, marginTop: 12 }}>
            <div className="form-group">
              <label className="form-label">Số B/L</label>
              <input className="form-input" value={form.bill_number} onChange={e => set('bill_number', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Số Seal</label>
              <input className="form-input" value={form.seal_number} onChange={e => set('seal_number', e.target.value)} />
            </div>
          </div>
          <div className="grid-2" style={{ gap: 12, marginTop: 12 }}>
            <div className="form-group">
              <label className="form-label">ETD</label>
              <input type="date" className="form-input" value={form.etd} onChange={e => set('etd', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">ETA</label>
              <input type="date" className="form-input" value={form.eta} onChange={e => set('eta', e.target.value)} />
            </div>
          </div>
          <div className="grid-2" style={{ gap: 12, marginTop: 12 }}>
            <div className="form-group">
              <label className="form-label">Tấn</label>
              <input type="number" className="form-input" value={form.tons} onChange={e => set('tons', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">CBM</label>
              <input type="number" className="form-input" value={form.cbm} onChange={e => set('cbm', e.target.value)} />
            </div>
          </div>
          <div className="grid-2" style={{ gap: 12, marginTop: 12 }}>
            <div className="form-group">
              <label className="form-label">Deadline</label>
              <input type="datetime-local" className="form-input" value={form.deadline} onChange={e => set('deadline', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Chế độ phân công</label>
              <select className="form-select" value={form.assignment_mode} onChange={e => set('assignment_mode', e.target.value)}>
                <option value="auto">Tự động (Auto)</option>
                <option value="manual">Thủ công (Manual)</option>
              </select>
            </div>
          </div>
          <div style={{ marginTop: 12 }}>
            <div className="form-label" style={{ marginBottom: 8 }}>Dịch vụ khác</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              {OTHER_SVC_KEYS.map(k => (
                <label key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!form.other_services[k]} onChange={() => toggleOs(k)} />
                  {OTHER_SVC_LABEL[k]}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Hủy</button>
          <button className="btn btn-primary btn-sm"
            disabled={!form.customer_name || !form.service_type || saving}
            onClick={submit}>
            {saving ? 'Đang lưu...' : 'Tạo Job'}
          </button>
        </div>
      </div>
    </div>
  );
}
