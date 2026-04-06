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

  const addCustomer = () => set('customers', [...form.customers, { ...EMPTY_CUSTOMER, quotes: [] }]);
  const updateCustomer = (i, c) => {
    const customers = [...form.customers];
    customers[i] = c;
    set('customers', customers);
  };
  const removeCustomer = (i) => set('customers', form.customers.filter((_, idx) => idx !== i));

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!form.report_date) return toast.error('Vui lòng chọn ngày báo cáo');
    if (form.customers.some(c => !c.company_name.trim())) {
      return toast.error('Vui lòng nhập tên công ty cho tất cả khách hàng');
    }
    mutation.mutate({
      ...form,
      total_contacts: parseInt(form.total_contacts) || form.customers.length,
      new_customers: parseInt(form.new_customers) || 0,
      customers: form.customers.map(c => ({
        ...c,
        quotes: c.interaction_type === 'quoted' ? (c.quotes || []) : [],
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
          <button type="button" className="btn btn-ghost" onClick={addCustomer}>
            + Thêm khách hàng
          </button>
        </div>

        {form.customers.length === 0 ? (
          <div style={{
            border: '2px dashed var(--border)', borderRadius: 'var(--radius)',
            padding: '40px 20px', textAlign: 'center', color: 'var(--text-2)',
          }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>👥</div>
            <p style={{ marginBottom: 12 }}>Chưa có khách hàng nào trong báo cáo này</p>
            <button type="button" className="btn btn-ghost" onClick={addCustomer}>
              + Thêm khách hàng đầu tiên
            </button>
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
