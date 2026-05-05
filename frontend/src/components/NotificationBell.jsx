import { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { getNotifications, getUnreadCount, markNotificationsRead } from '../api';
import { useModalZIndex } from '../hooks/useModalZIndex';

const TYPE_ICON = {
  ai_job_assigned:     '🤖',
  manual_job_assigned: '📋',
  deadline_request:    '⏰',
  deadline_proposed:   '⏰',
  deadline_reviewed:   '⏰',
  delete_request:      '❌',
  delete_decision:     '✅',
  new_job_created:     '🆕',
  job_reassigned:      '🔄',
};

function timeAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} giây trước`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} phút trước`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} giờ trước`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} ngày trước`;
  return new Date(iso).toLocaleDateString('vi-VN');
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const bellRef = useRef(null);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const zIndex = useModalZIndex();

  // Poll unread count — 5s when visible, 30s when tab hidden
  const [pollInterval, setPollInterval] = useState(
    typeof document !== 'undefined' && document.hidden ? 30000 : 5000
  );
  useEffect(() => {
    const handler = () => setPollInterval(document.hidden ? 30000 : 5000);
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  const { data: countData } = useQuery({
    queryKey: ['unreadCount'],
    queryFn: getUnreadCount,
    refetchInterval: pollInterval,
    refetchIntervalInBackground: false,
  });
  const count = countData?.count ?? 0;

  const { data: listData } = useQuery({
    queryKey: ['notifications'],
    queryFn: getNotifications,
    enabled: open,
  });
  const notifications = listData?.notifications ?? [];

  const markMut = useMutation({
    mutationFn: markNotificationsRead,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['unreadCount'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  function handleItemClick(n) {
    if (!n.read_at) markMut.mutate({ ids: [n.id] });
    setOpen(false);
    if (n.job_id) navigate(`#job=${n.job_id}`);
  }

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (bellRef.current && !bellRef.current.contains(e.target)) {
        if (!e.target.closest('[data-notif-panel]')) setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Position the panel under the bell
  const [panelPos, setPanelPos] = useState({ top: 64, right: 16 });
  useEffect(() => {
    if (open && bellRef.current) {
      const r = bellRef.current.getBoundingClientRect();
      setPanelPos({ top: r.bottom + 6, right: window.innerWidth - r.right });
    }
  }, [open]);

  return (
    <>
      <button
        ref={bellRef}
        className="btn btn-ghost btn-sm"
        onClick={() => setOpen(o => !o)}
        title="Thông báo"
        style={{ position: 'relative', color: '#6b7280', fontSize: 18, padding: '4px 10px' }}
      >
        🔔
        {count > 0 && (
          <span style={{
            position: 'absolute', top: 0, right: 2,
            background: 'var(--danger)', color: '#fff',
            borderRadius: 999, minWidth: 18, height: 18,
            fontSize: 10, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 5px',
          }}>
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && createPortal((
        <div
          data-notif-panel
          style={{
            position: 'fixed',
            top: panelPos.top, right: panelPos.right,
            width: 380, maxWidth: 'calc(100vw - 32px)', maxHeight: 500,
            background: '#fff',
            border: '1px solid var(--border)',
            borderRadius: 12,
            boxShadow: '0 12px 32px rgba(0,0,0,0.15)',
            display: 'flex', flexDirection: 'column',
            zIndex,
          }}
        >
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Thông báo</span>
            <button
              className="btn btn-ghost btn-sm"
              style={{ fontSize: 11, padding: '2px 8px' }}
              disabled={count === 0 || markMut.isPending}
              onClick={() => markMut.mutate({ all: true })}
            >
              Đánh dấu đã đọc tất cả
            </button>
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {notifications.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
                Chưa có thông báo
              </div>
            ) : notifications.map(n => (
              <div
                key={n.id}
                onClick={() => handleItemClick(n)}
                style={{
                  padding: '10px 16px',
                  borderBottom: '1px solid var(--border)',
                  cursor: 'pointer',
                  background: n.read_at ? '#fff' : 'rgba(59,130,246,0.05)',
                  display: 'flex', gap: 10, alignItems: 'flex-start',
                }}
                onMouseEnter={e => e.currentTarget.style.background = n.read_at ? 'var(--bg)' : 'rgba(59,130,246,0.1)'}
                onMouseLeave={e => e.currentTarget.style.background = n.read_at ? '#fff' : 'rgba(59,130,246,0.05)'}
              >
                <div style={{ fontSize: 18, flexShrink: 0 }}>{TYPE_ICON[n.type] || '🔔'}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontWeight: n.read_at ? 500 : 700,
                    fontSize: 13, color: 'var(--text)',
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    {n.title}
                    {!n.read_at && (
                      <span style={{
                        width: 7, height: 7, borderRadius: '50%',
                        background: 'var(--info)', flexShrink: 0,
                      }} />
                    )}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2, lineHeight: 1.4 }}>
                    {n.message}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                    {timeAgo(n.created_at)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ), document.body)}
    </>
  );
}
