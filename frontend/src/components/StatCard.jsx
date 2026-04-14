// rows = [{ label, value, color }, ...] — renders two sub-counts instead of one big number
export default function StatCard({ label, value, icon, color = 'var(--primary)', onClick, loading, sublabel, rows }) {
  return (
    <div
      className="card"
      onClick={onClick}
      style={{
        cursor: onClick ? 'pointer' : 'default',
        position: 'relative',
        overflow: 'hidden',
        transition: 'all 0.2s ease',
      }}
      onMouseEnter={e => {
        if (onClick) {
          e.currentTarget.style.transform = 'translateY(-2px)';
          e.currentTarget.style.borderColor = color;
          e.currentTarget.style.boxShadow = `0 8px 24px rgba(0,0,0,0.3), 0 0 0 1px ${color}22`;
        }
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = '';
        e.currentTarget.style.borderColor = '';
        e.currentTarget.style.boxShadow = '';
      }}
    >
      {/* Glow top border */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 2,
        background: `linear-gradient(90deg, transparent, ${color}, transparent)`,
        opacity: 0.6,
      }} />

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12, color: 'var(--text-2)', fontWeight: 500, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            {label}
          </div>
          {loading ? (
            <div className="spinner" style={{ marginTop: 4 }} />
          ) : rows ? (
            <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
              {rows.map((r, i) => (
                <div key={i} style={{
                  flex: 1, padding: '6px 8px', borderRadius: 8,
                  background: `${r.color}12`, border: `1px solid ${r.color}30`,
                }}>
                  <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-display)', color: r.color, lineHeight: 1 }}>
                    {r.value ?? '—'}
                  </div>
                  <div style={{ fontSize: 10, color: r.color, fontWeight: 600, marginTop: 3, opacity: 0.8 }}>
                    {r.label}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 32, fontWeight: 700, fontFamily: 'var(--font-display)', color, lineHeight: 1 }}>
              {value ?? '—'}
            </div>
          )}
          {sublabel && (
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 6 }}>{sublabel}</div>
          )}
        </div>
        <div style={{
          width: 44, height: 44, borderRadius: 12,
          background: `${color}18`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 20, flexShrink: 0, marginLeft: 8,
        }}>
          {icon}
        </div>
      </div>

      {onClick && (
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 4 }}>
          Xem chi tiết →
        </div>
      )}
    </div>
  );
}
