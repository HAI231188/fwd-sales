import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { searchGlobal } from '../api';
import { useModalZIndex } from '../hooks/useModalZIndex';
import JobDetailModal from './JobDetailModal';
import CustomerJobsModal from './CustomerJobsModal';

const TK_STATUS_LABEL = {
  chua_truyen: 'Chưa truyền',
  dang_lam:    'Đang làm',
  thong_quan:  'Thông quan',
  giai_phong:  'Giải phóng',
  bao_quan:    'Bảo quan',
};

function fmtDate(val) {
  if (!val) return '—';
  return new Date(val).toLocaleDateString('vi-VN');
}

// Case-insensitive substring highlight. Returns React fragments.
function highlightMatch(text, keyword) {
  if (!keyword || text == null || text === '') return text || '—';
  const t = String(text);
  const k = String(keyword);
  const lt = t.toLowerCase();
  const lk = k.toLowerCase();
  const out = [];
  let cursor = 0;
  let key = 0;
  while (cursor <= t.length) {
    const idx = lt.indexOf(lk, cursor);
    if (idx === -1) {
      out.push(t.slice(cursor));
      break;
    }
    if (idx > cursor) out.push(t.slice(cursor, idx));
    out.push(
      <mark key={`m${key++}`} style={{ background: '#fef08a', color: 'inherit', padding: 0 }}>
        {t.slice(idx, idx + k.length)}
      </mark>
    );
    cursor = idx + k.length;
    if (k.length === 0) break;
  }
  return out;
}

const dateInputStyle = {
  padding: '5px 8px',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: 12,
  color: 'var(--text)',
  background: '#fff',
  outline: 'none',
};

export default function GlobalSearch() {
  const [from, setFrom] = useState('');
  const [to, setTo]     = useState('');
  const [query, setQuery]                   = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [showDropdown, setShowDropdown]     = useState(false);
  const [rect, setRect]                     = useState(null);
  const [selectedJobId, setSelectedJobId]           = useState(null);
  const [selectedPipelineId, setSelectedPipelineId] = useState(null);

  const wrapperRef = useRef(null);
  const inputRef   = useRef(null);
  const zIndex     = useModalZIndex();

  const dateRangeSet = !!(from && to);

  // Debounce query 300ms
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(id);
  }, [query]);

  // Position dropdown relative to the input — fixed, recalculated on resize/scroll
  useEffect(() => {
    if (!showDropdown) return;
    const update = () => {
      if (inputRef.current) setRect(inputRef.current.getBoundingClientRect());
    };
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [showDropdown, debouncedQuery]);

  // Click outside closes dropdown.
  // The portal lives outside wrapperRef, so also accept clicks marked
  // with the data attribute on the dropdown itself.
  useEffect(() => {
    if (!showDropdown) return;
    const handler = (e) => {
      if (wrapperRef.current && wrapperRef.current.contains(e.target)) return;
      if (e.target.closest && e.target.closest('[data-global-search-dropdown="true"]')) return;
      setShowDropdown(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDropdown]);

  // ESC closes dropdown — only while open, so we don't steal ESC from open modals.
  useEffect(() => {
    if (!showDropdown) return;
    const handler = (e) => { if (e.key === 'Escape') setShowDropdown(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [showDropdown]);

  const enabled = dateRangeSet && debouncedQuery.length > 0;
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['globalSearch', debouncedQuery, from, to],
    queryFn: () => searchGlobal({ q: debouncedQuery, from, to }),
    enabled,
    staleTime: 30_000,
    keepPreviousData: true,
  });

  const jobs            = data?.jobs            || [];
  const customers       = data?.customers       || [];
  const totalJobs       = data?.total_jobs      || 0;
  const totalCustomers  = data?.total_customers || 0;
  const empty = enabled && !isLoading && jobs.length === 0 && customers.length === 0;

  function openJob(id) {
    setShowDropdown(false);
    setSelectedJobId(id);
  }
  function openCustomer(pipelineId) {
    setShowDropdown(false);
    setSelectedPipelineId(pipelineId);
  }

  return (
    <>
      <div
        ref={wrapperRef}
        style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, justifyContent: 'center' }}
      >
        {/* Date range — compact (~280px combined) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            title="Từ ngày"
            style={{ ...dateInputStyle, width: 130 }}
          />
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>→</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            title="Đến ngày"
            style={{ ...dateInputStyle, width: 130 }}
          />
        </div>

        {/* Search input + leading icon */}
        <div style={{ position: 'relative' }}>
          <span
            style={{
              position: 'absolute',
              left: 10, top: '50%',
              transform: 'translateY(-50%)',
              fontSize: 13,
              color: 'var(--text-3)',
              pointerEvents: 'none',
            }}
          >🔍</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            disabled={!dateRangeSet}
            onChange={(e) => { setQuery(e.target.value); setShowDropdown(true); }}
            onFocus={() => { if (debouncedQuery) setShowDropdown(true); }}
            placeholder={dateRangeSet ? 'Tìm kiếm...' : 'Vui lòng chọn khoảng thời gian'}
            style={{
              width: 300,
              padding: '7px 10px 7px 30px',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 13,
              background: dateRangeSet ? '#fff' : 'var(--bg)',
              color: dateRangeSet ? 'var(--text)' : 'var(--text-3)',
              outline: 'none',
            }}
          />
        </div>
      </div>

      {/* Dropdown — portal so it escapes the Navbar stacking context */}
      {showDropdown && enabled && rect && createPortal(
        <div
          data-global-search-dropdown="true"
          style={{
            position: 'fixed',
            top:  rect.bottom + 4,
            left: rect.left,
            width: Math.max(rect.width, 480),
            maxWidth: 600,
            maxHeight: 500,
            overflowY: 'auto',
            background: '#fff',
            border: '1px solid var(--border)',
            borderRadius: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
            zIndex,
            fontSize: 13,
          }}
        >
          {(isLoading || isFetching) && jobs.length === 0 && customers.length === 0 && (
            <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-2)', fontSize: 12 }}>
              Đang tìm...
            </div>
          )}

          {empty && !isFetching && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-2)', fontSize: 12 }}>
              Không tìm thấy kết quả phù hợp
            </div>
          )}

          {jobs.length > 0 && (
            <div>
              <div style={{
                padding: '8px 12px',
                background: 'var(--bg)',
                fontSize: 11, fontWeight: 700,
                color: 'var(--text-2)',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                borderBottom: '1px solid var(--border)',
              }}>
                Jobs ({totalJobs} kết quả{totalJobs > jobs.length ? ` — hiển thị ${jobs.length}` : ''})
              </div>
              {jobs.map((j) => (
                <div
                  key={`j_${j.id}`}
                  onClick={() => openJob(j.id)}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(34,197,94,0.06)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; }}
                  style={{
                    padding: '10px 12px',
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 3 }}>
                    📋 {highlightMatch(j.job_code, debouncedQuery)} — {highlightMatch(j.customer_name, debouncedQuery)}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
                    SI: {highlightMatch(j.si_number, debouncedQuery)}
                    {j.tk_status ? <> &nbsp;|&nbsp; {TK_STATUS_LABEL[j.tk_status] || j.tk_status}</> : null}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    Deadline: {fmtDate(j.deadline)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {customers.length > 0 && (
            <div>
              <div style={{
                padding: '8px 12px',
                background: 'var(--bg)',
                fontSize: 11, fontWeight: 700,
                color: 'var(--text-2)',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
                borderTop: jobs.length > 0 ? '1px solid var(--border)' : 'none',
                borderBottom: '1px solid var(--border)',
              }}>
                Khách hàng ({totalCustomers} kết quả{totalCustomers > customers.length ? ` — hiển thị ${customers.length}` : ''})
              </div>
              {customers.map((c) => (
                <div
                  key={`c_${c.pipeline_id}`}
                  onClick={() => openCustomer(c.pipeline_id)}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(34,197,94,0.06)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = '#fff'; }}
                  style={{
                    padding: '10px 12px',
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 3 }}>
                    🏢 {highlightMatch(c.company_name, debouncedQuery)}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
                    LH: {highlightMatch(c.contact_person, debouncedQuery)}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                    MST: {highlightMatch(c.tax_code, debouncedQuery)}
                    &nbsp;|&nbsp; {highlightMatch(c.phone, debouncedQuery)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>,
        document.body
      )}

      {selectedJobId && (
        <JobDetailModal jobId={selectedJobId} onClose={() => setSelectedJobId(null)} />
      )}
      {selectedPipelineId && (
        <CustomerJobsModal
          pipelineId={selectedPipelineId}
          from={from}
          to={to}
          onClose={() => setSelectedPipelineId(null)}
        />
      )}
    </>
  );
}
