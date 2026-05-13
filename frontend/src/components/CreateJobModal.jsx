import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { getLogStaff, searchJobCustomers } from '../api';
import { useModalZIndex } from '../hooks/useModalZIndex';

const CONT_TYPES = ['20DC','40DC','40HC','45HC','20RF','40RF'];
const OTHER_SVC_KEYS = ['ktcl','kiem_dich','hun_trung','co','khac'];
const OTHER_SVC_LABEL = { ktcl:'KTCL', kiem_dich:'Kiểm dịch', hun_trung:'Hun trùng', co:'CO', khac:'Khác' };

// Container quantity matrix — keyed by CONT_TYPES, every type starts at 0.
// Detail rows in `containers` state are reconciled from this map (see setQty
// below): increasing a type appends empty rows, decreasing drops from the end
// with a confirm-before-discard prompt if the dropped row carries data.
const ZERO_QTY = () => Object.fromEntries(CONT_TYPES.map(t => [t, 0]));

const INIT_FORM = {
  job_code: '', si_number: '', customer_name: '', customer_address: '', customer_tax_code: '',
  // Invoice info (L15) — required when "Khách mới" tab is active.
  company_full_name: '', invoice_address: '', invoice_tax_code: '',
  sales_id: '', pol: '', pod: '', mbl_no: '', hbl_no: '',
  etd: '', eta: '', tons: '', cbm: '', kg: '', so_kien: '', deadline: '', han_lenh: '',
  service_type: 'tk', other_services: {}, destination: '',
  // Loại lô — required; 'export' is the dominant case so it's the safe default.
  import_export: 'export',
};

export default function CreateJobModal({ onClose, onCreated }) {
  const zIndex = useModalZIndex();
  const { data: staff = [] } = useQuery({ queryKey: ['logStaff'], queryFn: getLogStaff });
  const salesStaff = staff.filter(s => s.role === 'sales' || s.role === 'lead');

  // Customer search
  const [searchMode, setSearchMode] = useState('search');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const searchRef = useRef();
  const timerRef = useRef();

  // Form
  const [cargoType, setCargoType] = useState('fcl');
  // The quantity matrix is the source of truth for FCL row count + types.
  // `containers` is reconciled from it via setQty (preserves cont_number/seal
  // values for surviving rows; warns before dropping rows with data).
  const [contQty, setContQty] = useState(ZERO_QTY());
  const [containers, setContainers] = useState([]);
  const [form, setForm] = useState(INIT_FORM);
  const [saving, setSaving] = useState(false);
  const [showTransferConfirm, setShowTransferConfirm] = useState(false);
  const [invoiceErr, setInvoiceErr] = useState('');

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const toggleOs = k => setForm(f => ({ ...f, other_services: { ...f.other_services, [k]: !f.other_services[k] } }));
  const locked = !!selectedCustomer;

  // Switching Loại lô also rewrites han_lenh so the value survives across the
  // date ↔ datetime-local input switch:
  //   xuất → nhập: 'YYYY-MM-DDTHH:MM' → 'YYYY-MM-DD'   (drop time per spec)
  //   nhập → xuất: 'YYYY-MM-DD'       → 'YYYY-MM-DDT00:00'  (datetime-local needs T)
  function setImportExport(next) {
    setForm(f => {
      const cur = f.han_lenh || '';
      let newVal = cur;
      if (next === 'import' && cur.includes('T')) newVal = cur.slice(0, 10);
      else if (next === 'export' && cur && !cur.includes('T') && /^\d{4}-\d{2}-\d{2}$/.test(cur)) {
        newVal = `${cur}T00:00`;
      }
      return { ...f, import_export: next, han_lenh: newVal };
    });
  }

  // Cargo-type switcher — per spec, FCL↔LCL transitions reset the matrix + rows.
  // Direct setter is only used inside this wrapper so the two stay aligned.
  function selectCargoType(type) {
    if (type === cargoType) return;
    setCargoType(type);
    setContQty(ZERO_QTY());
    setContainers([]);
  }

  // Update only cont_number / seal_number — cont_type is now read-only and
  // governed by the quantity matrix.
  const updateCont = (i, k, v) => setContainers(cs => cs.map((c, idx) => idx === i ? { ...c, [k]: v } : c));

  const totalQty = Object.values(contQty).reduce((s, n) => s + (n || 0), 0);

  // Reconcile a single matrix cell change into both contQty + containers.
  // Walks CONT_TYPES in order so the detail list groups containers by type.
  function setQty(type, raw) {
    const n = Math.max(0, parseInt(raw, 10) || 0);
    if (n === (contQty[type] || 0)) return;

    if (n < (contQty[type] || 0)) {
      const existingOfType = containers.filter(c => c.cont_type === type);
      const toDrop = existingOfType.slice(n);
      const withData = toDrop.filter(c => (c.cont_number || '').trim() || (c.seal_number || '').trim());
      if (withData.length > 0) {
        const names = withData
          .map(c => (c.cont_number || '').trim() || `(${type} chưa nhập số)`)
          .join(', ');
        const ok = window.confirm(`Cont ${names} sẽ bị xóa, tiếp tục?`);
        if (!ok) return;
      }
    }

    const nextQty = { ...contQty, [type]: n };
    setContQty(nextQty);
    setContainers(cs => {
      const out = [];
      for (const t of CONT_TYPES) {
        const existing = cs.filter(c => c.cont_type === t);
        const want = nextQty[t] || 0;
        for (let i = 0; i < want; i++) {
          out.push(existing[i] || { cont_type: t, cont_number: '', seal_number: '' });
        }
      }
      return out;
    });
  }

  // Debounced customer search
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
      // Pre-fill invoice info from pipeline snapshot (L15).
      company_full_name: c.company_full_name || '',
      invoice_address:   c.invoice_address   || '',
      invoice_tax_code:  c.pipeline_tax_code || '',
    }));
  }

  function clearSelection() {
    setSelectedCustomer(null);
    setSearchQuery('');
    setForm(f => ({ ...f, customer_name: '', customer_address: '', customer_tax_code: '', sales_id: '' }));
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  function switchToNew() {
    // Always start with empty fields. Pre-filling from searchQuery (the previous
    // approach) caused users who clicked "+ Thêm khách mới" to submit truncated
    // names ("[TEST] C" instead of the full company name). Empty fields force
    // the user to type the full customer name.
    setSearchMode('new'); setSelectedCustomer(null); setShowDropdown(false); setSearchQuery('');
    setForm(f => ({ ...f, customer_name: '', customer_address: '', customer_tax_code: '' }));
    setTimeout(() => searchRef.current?.focus(), 0);
  }
  function switchToSearch() {
    setSearchMode('search'); setSelectedCustomer(null); setSearchQuery('');
    setForm(f => ({ ...f, customer_name: '', customer_address: '', customer_tax_code: '', sales_id: '' }));
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  async function submit({ confirmedTransfer = false } = {}) {
    setInvoiceErr('');
    if (!form.customer_name || !form.service_type) return;
    // Loại lô guard — required; default makes this near-impossible to hit, but
    // we keep the check so a future caller that clears the field can't slip past.
    if (!['export', 'import'].includes(form.import_export)) {
      setInvoiceErr('Vui lòng chọn loại lô (Hàng xuất / Hàng nhập)');
      return;
    }
    // Hạn lệnh / Cutoff guard — required on create for both modes; the message
    // matches the field label visible to the user (Hạn lệnh vs Cutoff time).
    if (!(form.han_lenh || '').trim()) {
      setInvoiceErr(form.import_export === 'import'
        ? 'Vui lòng nhập Hạn lệnh'
        : 'Vui lòng nhập Cutoff time');
      return;
    }
    // Hàng nhập: every auto-generated container row must carry cont_number + seal.
    // Hàng xuất: optional (carrier supplies later) — no row-level check.
    if (cargoType === 'fcl' && form.import_export === 'import') {
      const incomplete = containers.some(c =>
        !(c.cont_number || '').trim() || !(c.seal_number || '').trim());
      if (incomplete) {
        setInvoiceErr('Hàng nhập phải nhập đủ số cont và seal cho tất cả container');
        return;
      }
    }
    // Invoice-info guard (L15) — required only in "Khách mới" mode (new customer).
    if (searchMode === 'new') {
      const missing = !form.company_full_name?.trim() || !form.invoice_tax_code?.trim() ||
                      !form.invoice_address?.trim();
      if (missing) {
        setInvoiceErr('Vui lòng nhập đủ thông tin xuất hóa đơn');
        return;
      }
    }
    // Pipeline transfer guard: if user changed sales_id away from the selected customer's
    // existing sales, require explicit confirmation (destructive — old sales loses data).
    const willTransfer = !!(selectedCustomer && selectedCustomer.sales_id && form.sales_id &&
      Number(form.sales_id) !== Number(selectedCustomer.sales_id));
    if (willTransfer && !confirmedTransfer) {
      setShowTransferConfirm(true);
      return;
    }
    setSaving(true);
    try {
      await onCreated({
        ...form,
        customer_id: selectedCustomer?.customer_id || null,
        sales_id: form.sales_id || null,
        tons: form.tons ? Number(form.tons) : null,
        cbm: form.cbm ? Number(form.cbm) : null,
        kg: form.kg ? Number(form.kg) : null,
        so_kien: form.so_kien ? Number(form.so_kien) : null,
        deadline: form.deadline || null,
        han_lenh: form.han_lenh || null,
        si_number: form.si_number || null,
        mbl_no: form.mbl_no || null,
        hbl_no: form.hbl_no || null,
        etd: form.etd || null,
        eta: form.eta || null,
        cargo_type: cargoType,
        containers: cargoType === 'fcl' ? containers.filter(c => c.cont_type) : [],
        is_new_customer: searchMode === 'new',
      });
      onClose();
    } finally { setSaving(false); }
  }

  return createPortal((
    <div className="modal-overlay" style={{ zIndex }} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal modal-lg" style={{ maxHeight: '92vh' }}>
        <div className="modal-header">
          <h3>Tạo Job Mới</h3>
          <button className="btn btn-ghost btn-sm btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">

          {/* Service + Loại lô + Destination — Loại lô sits inline so users
              cannot miss it (was buried below the FCL/LCL toggle previously). */}
          <div className="form-grid-5">
            <div className="form-group">
              <label className="form-label">Mã Job</label>
              <input className="form-input" value={form.job_code} onChange={e => set('job_code', e.target.value)} placeholder="VD: SLB-2024-001" />
            </div>
            <div className="form-group">
              <label className="form-label">Mã SI</label>
              <input className="form-input" value={form.si_number} onChange={e => set('si_number', e.target.value)} placeholder="Số SI" />
            </div>
            <div className="form-group">
              <label className="form-label">Loại dịch vụ *</label>
              <select className="form-select" value={form.service_type} onChange={e => set('service_type', e.target.value)}>
                <option value="tk">Tờ khai (TK)</option>
                <option value="truck">Vận chuyển (Truck)</option>
                <option value="both">TK + Vận chuyển</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Loại lô *</label>
              <div style={{ display: 'flex', gap: 4 }}>
                {[
                  { value: 'export', label: 'Hàng xuất', color: '#16a34a', dim: 'rgba(34,197,94,0.12)' },
                  { value: 'import', label: 'Hàng nhập', color: '#d97706', dim: 'rgba(217,119,6,0.12)' },
                ].map(opt => {
                  const active = form.import_export === opt.value;
                  return (
                    <label key={opt.value} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                      cursor: 'pointer', fontSize: 12, padding: '6px 6px', borderRadius: 6, whiteSpace: 'nowrap',
                      border: `1.5px solid ${active ? opt.color : 'var(--border)'}`,
                      background: active ? opt.dim : '', fontWeight: active ? 600 : 400,
                      color: active ? opt.color : 'var(--text)' }}>
                      <input type="radio" name="import_export" value={opt.value} checked={active}
                        onChange={() => setImportExport(opt.value)} style={{ accentColor: opt.color }} />
                      {opt.label}
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Điểm đến</label>
              <select className="form-select" value={form.destination || ''} onChange={e => set('destination', e.target.value || null)}>
                <option value="">— Chọn —</option>
                <option value="hai_phong">Hải Phòng</option>
                <option value="other">Khác</option>
              </select>
              {(form.service_type === 'truck' || form.service_type === 'both') && !form.destination && (
                <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 4 }}>⚠ Vận chuyển cần chọn điểm đến</div>
              )}
            </div>
          </div>

          {/* FCL / LCL toggle — uses selectCargoType so switching resets the matrix. */}
          <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)', marginRight: 4 }}>Loại hàng:</span>
            {['fcl','lcl'].map(type => (
              <label key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13,
                padding: '4px 14px', borderRadius: 20, border: `1.5px solid ${cargoType === type ? 'var(--primary)' : 'var(--border)'}`,
                background: cargoType === type ? 'var(--primary-dim)' : '', fontWeight: cargoType === type ? 600 : 400 }}>
                <input type="radio" name="cargo_type" value={type} checked={cargoType === type}
                  onChange={() => selectCargoType(type)} style={{ accentColor: 'var(--primary)' }} />
                {type.toUpperCase()}
              </label>
            ))}
          </div>

          {/* Customer search */}
          <div style={{ marginTop: 12, padding: 12, background: 'var(--bg)', borderRadius: 8, border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginRight: 4 }}>Khách hàng</span>
              <button type="button" className={`btn btn-sm ${searchMode === 'search' ? 'btn-primary' : 'btn-ghost'}`}
                style={{ padding: '2px 10px', fontSize: 11 }} onClick={switchToSearch}>Tìm khách cũ</button>
              <button type="button" className={`btn btn-sm ${searchMode === 'new' ? 'btn-primary' : 'btn-ghost'}`}
                style={{ padding: '2px 10px', fontSize: 11 }} onClick={switchToNew}>Khách mới</button>
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
                    <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={clearSelection}>✕</button>
                  </div>
                ) : (
                  <>
                    <input ref={searchRef} className="form-input" placeholder="Tìm tên công ty (khách đã booked)..."
                      value={searchQuery}
                      onChange={e => { setSearchQuery(e.target.value); if (!e.target.value) { setSearchResults([]); setShowDropdown(false); } }}
                      onFocus={() => searchResults.length > 0 && setShowDropdown(true)}
                      onBlur={() => setTimeout(() => setShowDropdown(false), 200)} />
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
                          <div onMouseDown={() => switchToNew()}
                            style={{ padding: '10px 14px', cursor: 'pointer', color: 'var(--info)', fontSize: 12, fontStyle: 'italic' }}>
                            + Thêm khách mới
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            ) : (
              <>
                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label className="form-label">Tên khách hàng *</label>
                  <input className="form-input" value={form.customer_name}
                    onChange={e => set('customer_name', e.target.value)} placeholder="Tên ngắn gọn / nội bộ..." autoFocus />
                </div>
                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label className="form-label">Tên công ty (xuất HĐ) *</label>
                  <input className="form-input" value={form.company_full_name}
                    onChange={e => set('company_full_name', e.target.value)}
                    placeholder="VD: CÔNG TY CỔ PHẦN ABC VIỆT NAM" />
                </div>
                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label className="form-label">MST *</label>
                  <input className="form-input" value={form.invoice_tax_code}
                    onChange={e => set('invoice_tax_code', e.target.value)} placeholder="0301234567" />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Địa chỉ xuất HĐ *</label>
                  <input className="form-input" value={form.invoice_address}
                    onChange={e => set('invoice_address', e.target.value)}
                    placeholder="Địa chỉ ghi trên hóa đơn..." />
                </div>
              </>
            )}
            {/* Read-only invoice info preview when an existing customer is selected.
                Values come from the customer_pipeline snapshot fetched by
                /customer-search and stored in form state by selectCustomer().
                Edit path is /customers (TP/lead-only) — intentionally no inline
                editor here to avoid duplicating the Data khách hàng surface. */}
            {searchMode === 'search' && selectedCustomer && (
              <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--border)' }}>
                <div style={{ fontSize: 11, fontStyle: 'italic', color: 'var(--text-2)', marginBottom: 6 }}>
                  Thông tin xuất hóa đơn từ data khách hàng
                </div>
                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label className="form-label">Tên công ty (xuất HĐ)</label>
                  <input className="form-input" readOnly
                    value={form.company_full_name || ''}
                    style={{ background: 'var(--bg)', cursor: 'default' }}
                    placeholder="(chưa có — sửa tại trang Data khách hàng)" />
                </div>
                <div className="form-group" style={{ marginBottom: 8 }}>
                  <label className="form-label">MST</label>
                  <input className="form-input" readOnly
                    value={form.invoice_tax_code || ''}
                    style={{ background: 'var(--bg)', cursor: 'default' }}
                    placeholder="(chưa có — sửa tại trang Data khách hàng)" />
                </div>
                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label className="form-label">Địa chỉ xuất HĐ</label>
                  <input className="form-input" readOnly
                    value={form.invoice_address || ''}
                    style={{ background: 'var(--bg)', cursor: 'default' }}
                    placeholder="(chưa có — sửa tại trang Data khách hàng)" />
                </div>
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
                onChange={e => set('sales_id', e.target.value)}>
                <option value="">-- Chọn --</option>
                {salesStaff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {selectedCustomer && selectedCustomer.sales_id && form.sales_id &&
               Number(form.sales_id) !== Number(selectedCustomer.sales_id) && (
                <div style={{ fontSize: 11, color: 'var(--warning)', marginTop: 4 }}>
                  ⚠ Sẽ chuyển khách khỏi pipeline của {selectedCustomer.sales_name || 'sales cũ'}
                </div>
              )}
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
              <label className="form-label">MBL No</label>
              <input className="form-input" value={form.mbl_no} onChange={e => set('mbl_no', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">HBL No</label>
              <input className="form-input" value={form.hbl_no} onChange={e => set('hbl_no', e.target.value)} />
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

          {/* FCL: quantity matrix (Block 1) + auto-generated detail rows (Block 2) */}
          {cargoType === 'fcl' && (
            <div style={{ marginTop: 12 }}>
              {/* Block 1 — quantity matrix */}
              <div style={{ padding: 12, background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8 }}>
                  Số lượng cont theo loại
                </div>
                <div className="form-grid-3" style={{ gap: 8 }}>
                  {CONT_TYPES.map(t => (
                    <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ minWidth: 48, fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>{t}:</span>
                      <input type="number" min="0" step="1" className="form-input"
                        value={contQty[t] || 0}
                        onChange={e => setQty(t, e.target.value)}
                        style={{ width: 70, fontSize: 13, padding: '4px 8px' }} />
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-2)' }}>
                  Tổng: <strong style={{ color: 'var(--text)' }}>{totalQty}</strong> cont
                </div>
              </div>

              {/* Block 2 — auto-generated detail rows (cont_type is read-only) */}
              {totalQty > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <label className="form-label" style={{ margin: 0 }}>Chi tiết cont</label>
                    {form.import_export === 'import' && (
                      <span style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 500 }}>
                        ⚠ Hàng nhập: bắt buộc nhập đủ số cont và seal
                      </span>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {containers.map((c, i) => {
                      const importMissing = form.import_export === 'import'
                        && (!(c.cont_number || '').trim() || !(c.seal_number || '').trim());
                      return (
                        <div key={i} style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr', gap: 6, alignItems: 'center' }}>
                          <span style={{ fontWeight: 600, fontSize: 12, padding: '6px 10px', textAlign: 'center',
                            background: 'var(--bg)', borderRadius: 6, border: '1px solid var(--border)', color: 'var(--text-2)' }}>
                            {c.cont_type}
                          </span>
                          <input className="form-input" value={c.cont_number} placeholder="Số cont"
                            onChange={e => updateCont(i, 'cont_number', e.target.value)}
                            style={{ fontSize: 12, ...(importMissing && !(c.cont_number || '').trim()
                              ? { borderColor: 'var(--warning)' } : {}) }} />
                          <input className="form-input" value={c.seal_number} placeholder="Số seal"
                            onChange={e => updateCont(i, 'seal_number', e.target.value)}
                            style={{ fontSize: 12, ...(importMissing && !(c.seal_number || '').trim()
                              ? { borderColor: 'var(--warning)' } : {}) }} />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="grid-2" style={{ gap: 12, marginTop: 10 }}>
                <div className="form-group">
                  <label className="form-label">Tấn (tuỳ chọn)</label>
                  <input type="number" className="form-input" value={form.tons} onChange={e => set('tons', e.target.value)} />
                </div>
                <div className="form-group">
                  <label className="form-label">CBM (tuỳ chọn)</label>
                  <input type="number" className="form-input" value={form.cbm} onChange={e => set('cbm', e.target.value)} />
                </div>
              </div>
            </div>
          )}

          {/* LCL: so_kien + kg + cbm */}
          {cargoType === 'lcl' && (
            <div style={{ marginTop: 12 }}>
              <div style={{ marginBottom: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-2)' }}>Thông tin hàng lẻ (LCL)</div>
              <div className="form-grid-3" style={{ gap: 10 }}>
                <div className="form-group">
                  <label className="form-label">Số kiện *</label>
                  <input type="number" className="form-input" value={form.so_kien}
                    onChange={e => set('so_kien', e.target.value)} placeholder="Số kiện" />
                </div>
                <div className="form-group">
                  <label className="form-label">Kg *</label>
                  <input type="number" className="form-input" value={form.kg}
                    onChange={e => set('kg', e.target.value)} placeholder="Kg" />
                </div>
                <div className="form-group">
                  <label className="form-label">CBM *</label>
                  <input type="number" className="form-input" value={form.cbm}
                    onChange={e => set('cbm', e.target.value)} placeholder="CBM" />
                </div>
              </div>
            </div>
          )}

          {/* Other services + assignment */}
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
          <div className="grid-2" style={{ gap: 12, marginTop: 12 }}>
            <div className="form-group">
              <label className="form-label">Deadline</label>
              <input type="datetime-local" step={1800} className="form-input" value={form.deadline} onChange={e => set('deadline', e.target.value)} />
            </div>
            <div className="form-group">
              {form.import_export === 'import' ? (
                <>
                  <label className="form-label">Hạn lệnh *</label>
                  <input type="date" className="form-input"
                    value={form.han_lenh}
                    onChange={e => set('han_lenh', e.target.value)} />
                </>
              ) : (
                <>
                  <label className="form-label">Cutoff time *</label>
                  <input type="datetime-local" step={1800} className="form-input"
                    value={form.han_lenh}
                    onChange={e => set('han_lenh', e.target.value)} />
                </>
              )}
            </div>
          </div>
        </div>

        {invoiceErr && (
          <div style={{ margin: '0 16px 12px', padding: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: 'var(--danger)', fontSize: 13 }}>
            {invoiceErr}
          </div>
        )}
        <div className="modal-footer">
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Hủy</button>
          <button className="btn btn-primary btn-sm"
            disabled={!form.customer_name || !form.service_type || saving}
            onClick={() => submit()}>
            {saving ? 'Đang lưu...' : 'Tạo Job'}
          </button>
        </div>
      </div>

      {showTransferConfirm && (
        <div className="modal-overlay" style={{ zIndex: zIndex + 1 }}
          onClick={e => { if (e.target === e.currentTarget) setShowTransferConfirm(false); }}>
          <div className="modal" style={{ maxWidth: 480, width: '95%' }}>
            <div className="modal-header">
              <h3 style={{ margin: 0, fontSize: 16 }}>Chuyển khách sang sales khác</h3>
              <button className="btn btn-ghost btn-sm btn-icon" onClick={() => setShowTransferConfirm(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ padding: 16, fontSize: 13, lineHeight: 1.5 }}>
              <p>
                Khách hàng <strong>{form.customer_name}</strong> hiện thuộc pipeline của{' '}
                <strong>{selectedCustomer?.sales_name || 'sales cũ'}</strong>.
              </p>
              <p style={{ color: 'var(--danger)', marginTop: 10 }}>
                Tiếp tục sẽ chuyển khách sang{' '}
                <strong>{salesStaff.find(s => Number(s.id) === Number(form.sales_id))?.name || 'sales mới'}</strong>{' '}
                và <strong>xóa toàn bộ lịch sử pipeline</strong> (bao gồm các tương tác đã ghi nhận) của{' '}
                <strong>{selectedCustomer?.sales_name || 'sales cũ'}</strong>. Hành động này không thể hoàn tác.
              </p>
              <p style={{ marginTop: 10 }}>Xác nhận?</p>
            </div>
            <div className="modal-footer" style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: 12, borderTop: '1px solid var(--border)' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowTransferConfirm(false)} disabled={saving}>Hủy</button>
              <button className="btn btn-danger btn-sm"
                disabled={saving}
                onClick={() => { setShowTransferConfirm(false); submit({ confirmedTransfer: true }); }}>
                {saving ? 'Đang lưu...' : 'Chuyển khách'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  ), document.body);
}
