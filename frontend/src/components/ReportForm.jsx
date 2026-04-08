import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { createReport } from '../api';
import CustomerForm, { EMPTY_CUSTOMER } from './CustomerForm';
import { format } from 'date-fns';

export default function ReportForm({ onSuccess, existingReport }) {
  const qc = useQueryClient();

  const [form, setForm] = useState({
    report_date: format(new Date(), 'yyyy-MM-dd'),
    total_contacts: '',
    new_customers: '',
    issues: '',
    customers: [],
    ...existingReport,
  });

  const [showTypeChoice, setShowTypeChoice] = useState(false);

  const mutation = useMutation({
    mutationFn: createReport,
    onSuccess: (res) => {
      toast.success('Đã lưu báo cáo thành công! 🎉');
      qc.invalidateQueries({ queryKey: ['reports'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      if (onSuccess) onSuccess(res.id);
    },
    onError: (err) => {
      toast.error(err?.error || 'Lưu thất bại, vui lòng thử lại');
    },
  });

  const set = (field, value) => setForm(f => ({ ...f, [field]: value }));

  const addCustomer = (type) => {
    const base = { ...EMPTY_CUSTOMER, quotes: [], _type: type };
    if (type === 'existing') base._existingId = null;
    set('customers', [...form.customers, base]);
    setShowTypeChoice(false);
  };

  const updateCustomer = (i, c) => {
    const customers = [...form.customers];
    customers[i] = c;
    set('customers', customers);
  };
  const removeCustomer = (i) => set('customers', form.customers.filter((_, idx) => idx !== i));

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.report_date) return toast.error('Vui lòng chọn ngày báo cáo');

    for (const c of form.customers) {
      if (c._type === 'existing' && !c._existingId) {
        return toast.error('Vui lòng chọn khách hàng cũ hoặc xóa mục chưa hoàn thành');
      }
      if (c._type !== 'existing' && !c.company_name.trim()) {
        return toast.error('Vui lòng nhập tên công ty cho tất cả khách hàng');
      }
    }

    mutation.mutate({
      ...form,
      total_contacts: parseInt(form.total_contacts) || form.customers.length,
      new_customers: parseInt(form.new_customers) || 0,
      customers: form.customers.map(({ _type, _existingId, ...c }) => ({
        ...c,
        quotes: c.interaction_type === 'quoted'
          ? (c.quotes || []).map(q => ({
              ...q,
              carrier: (q.options || []).find(o => o.carrier)?.carrier || q.carrier || '',
              price: q.options ? JSON.stringify(q.options) : q.price,
            }))
          : [],
      })),
    });
  };

  return (
    <form onSubmit={handleSubmit}>
      {/* Summary section */}
      <div style={{
        background: 'var(--bg-card)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', padding: 24, marginBottom: 24,
      }}>
        <h3 style={{ fontFamily: 'var(--font-display)', marginBottom: 20, fontSize: 16 }}>
          📊 Tổng quan ngày báo cáo
        </h3>

        <div className="grid-3" style={{ gap: 16, marginBottom: 16 }}>
          <div className="form-group">
            <label className="form-label">Ngày báo cáo *</label>
            <input type="date" className="form-input" required value={form.report_date} onChange={e => set('report_date', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Tổng lượt tiếp cận</label>
            <input type="number" min="0" className="form-input" placeholder="Số khách đã tiếp cận" value={form.total_contacts} onChange={e => set('total_contacts', e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Khách hàng mới</label>
            <input type="number" min="0" className="form-input" placeholder="Số khách mới hôm nay" value={form.new_customers} onChange={e => set('new_customers', e.target.value)} />
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">Vấn đề cần hỗ trợ từ trưởng phòng</label>
          <textarea
            className="form-textarea"
            rows={3}
            placeholder="Các vấn đề, khó khăn cần báo cáo lên trưởng phòng..."
            value={form.issues}
            onChange={e => set('issues', e.target.value)}
          />
        </div>
      </div>

      {/* Customer list */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 16 }}>
            👥 Danh sách khách hàng ({form.customers.length})
          </h3>

          {/* Add customer button / type chooser */}
          <div style={{ position: 'relative' }}>
            {!showTypeChoice ? (
              <button type="button" className="btn btn-ghost" onClick={() => setShowTypeChoice(true)}>
                + Thêm khách hàng
              </button>
            ) : (
              <div style={{
                display: 'flex', gap: 8, alignItems: 'center',
                background: 'var(--bg-card)', border: '1px solid var(--border)',
                borderRadius: 10, padding: '8px 12px', boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
              }}>
                <span style={{ fontSize: 12, color: 'var(--text-2)', marginRight: 4 }}>Loại khách:</span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => addCustomer('new')}
                >
                  ✨ Khách hàng mới
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => addCustomer('existing')}
                  style={{ border: '1px solid var(--primary)', color: 'var(--primary)' }}
                >
                  🔍 Khách hàng cũ
                </button>
                <button
                  type="button"
                  onClick={() => setShowTypeChoice(false)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-2)', fontSize: 18, lineHeight: 1, padding: '0 4px' }}
                >
                  ×
                </button>
              </div>
            )}
          </div>
        </div>

        {form.customers.length === 0 ? (
          <div style={{
            border: '2px dashed var(--border)', borderRadius: 'var(--radius)',
            padding: '40px 20px', textAlign: 'center', color: 'var(--text-2)',
          }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>👥</div>
            <p style={{ marginBottom: 16 }}>Chưa có khách hàng nào trong báo cáo này</p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button type="button" className="btn btn-primary" onClick={() => addCustomer('new')}>
                ✨ Thêm khách hàng mới
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => addCustomer('existing')}
                style={{ border: '1px solid var(--primary)', color: 'var(--primary)' }}
              >
                🔍 Thêm khách hàng cũ
              </button>
            </div>
          </div>
        ) : (
          form.customers.map((c, i) => (
            <CustomerForm
              key={i}
              customer={c}
              index={i}
              onChange={(updated) => updateCustomer(i, updated)}
              onRemove={() => removeCustomer(i)}
            />
          ))
        )}
      </div>

      {/* Submit */}
      <div style={{ display: 'flex', gap: 12, justifyContent: 'flex-end' }}>
        <div style={{ fontSize: 13, color: 'var(--text-2)', alignSelf: 'center' }}>
          {form.customers.length} khách hàng ·{' '}
          {form.customers.reduce((a, c) => a + (c.quotes?.length || 0), 0)} báo giá
        </div>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={mutation.isPending}
          style={{ minWidth: 160 }}
        >
          {mutation.isPending ? (
            <><span className="spinner" style={{ width: 16, height: 16 }} /> Đang lưu...</>
          ) : (
            '💾 Lưu Báo Cáo'
          )}
        </button>
      </div>
    </form>
  );
}
