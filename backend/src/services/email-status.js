// CP5.1 — Per-transport mail status derivation for Vùng 2.
//
// Vùng 2 in the DD planning workspace shows one card per transport_company
// involved in the job (either currently — alive bookings — or historically —
// previously mailed). Each card needs a status pill that captures the diff
// between what was last sent to this transport and what the job currently
// looks like for this transport.
//
// The diff is **booking_ids only**: add/remove a booking, or move a booking
// to a different transport, both count. Per-booking field changes (date,
// cost, vehicle, receiver, etc.) are NOT detected here — DD verifies those
// with the carrier verbally per spec.
//
// Status enum:
//   'chua_gui'      — no mail history for (job, transport)
//   'da_gui'        — latest 'new' mail matches current booking set exactly
//   'co_thay_doi'   — latest 'new' mail's booking set differs from current
//   'can_huy'       — latest is 'new', but the transport has zero current
//                     bookings (all moved/removed) → DD needs to send HỦY
//   'da_huy'        — latest mail is a 'sent' cancel

const db = require('../db');

// Normalize last_sent_data to extract booking_ids regardless of snapshot
// vintage. CP5.1 writes `booking_ids` at the top level. Older rows (CP3+)
// only had a nested `bookings: [...]` array; pull ids out of there as a
// fallback so historical rows still compute a sensible diff.
function extractBookingIds(lastSentData) {
  if (!lastSentData || typeof lastSentData !== 'object') return [];
  if (Array.isArray(lastSentData.booking_ids)) {
    return lastSentData.booking_ids.filter(x => Number.isFinite(Number(x))).map(Number);
  }
  if (Array.isArray(lastSentData.bookings_snapshot)) {
    return lastSentData.bookings_snapshot.map(b => b.id).filter(x => Number.isFinite(Number(x))).map(Number);
  }
  if (Array.isArray(lastSentData.bookings)) {
    return lastSentData.bookings.map(b => b.id).filter(x => Number.isFinite(Number(x))).map(Number);
  }
  return [];
}

// CP5.2 — expose the per-booking snapshot so the cancel-confirm modal can
// preview what's about to be cancelled. Handles both new CP5.1 shape
// (bookings_snapshot[]) and legacy CP3+ shape (bookings[] with extra fields).
function extractSnapshot(lastSentData) {
  if (!lastSentData || typeof lastSentData !== 'object') return null;
  const src = Array.isArray(lastSentData.bookings_snapshot) ? lastSentData.bookings_snapshot
            : Array.isArray(lastSentData.bookings)         ? lastSentData.bookings
            : null;
  if (!src || src.length === 0) return null;
  return src.map(b => ({
    id:                Number(b.id),
    booking_code:      b.booking_code || null,
    cont_number:       b.cont_number  || null,
    cont_type:         b.cont_type    || null,
    planned_datetime:  b.planned_datetime || null,
    delivery_location: b.delivery_location || null,
  }));
}

function diffSets(currentIds, lastIds) {
  const curSet = new Set(currentIds);
  const lastSet = new Set(lastIds);
  const added = currentIds.filter(id => !lastSet.has(id));
  const removed = lastIds.filter(id => !curSet.has(id));
  return { added, removed };
}

async function getMailStatusPerTransport(jobId) {
  const id = Number(jobId);
  if (!Number.isFinite(id)) throw new Error('jobId không hợp lệ');

  const { rows: [job] } = await db.query(
    `SELECT id, job_code FROM jobs WHERE id = $1 AND deleted_at IS NULL`, [id]
  );
  if (!job) throw new Error('Không tìm thấy job');

  // Single LATERAL-joined query: union of currently-used + historically-mailed
  // transports, plus the latest email_history row per transport, plus the
  // current alive booking IDs per transport. Everything we need in one trip.
  const { rows } = await db.query(`
    WITH transports AS (
      SELECT DISTINCT tb.transport_company_id
        FROM truck_bookings tb
       WHERE tb.job_id = $1 AND tb.deleted_at IS NULL
         AND tb.transport_company_id IS NOT NULL
      UNION
      SELECT DISTINCT eh.recipient_transport_company_id AS transport_company_id
        FROM email_history eh
       WHERE eh.job_id = $1 AND eh.deleted_at IS NULL
         AND eh.recipient_transport_company_id IS NOT NULL
    )
    SELECT
      t.transport_company_id,
      tc.name AS tc_current_name,
      COALESCE((
        SELECT json_agg(tb.id ORDER BY tb.id)
          FROM truck_bookings tb
         WHERE tb.job_id = $1 AND tb.deleted_at IS NULL
           AND tb.transport_company_id = t.transport_company_id
      ), '[]'::json) AS current_booking_ids,
      eh.id           AS last_email_id,
      eh.mail_type    AS last_mail_type,
      eh.status       AS last_mail_status,
      eh.created_at   AS last_sent_at,
      eh.last_sent_data AS last_sent_data
    FROM transports t
    LEFT JOIN transport_companies tc ON tc.id = t.transport_company_id
    LEFT JOIN LATERAL (
      SELECT id, mail_type, status, created_at, last_sent_data
        FROM email_history
       WHERE job_id = $1
         AND recipient_transport_company_id = t.transport_company_id
         AND deleted_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 1
    ) eh ON true
    ORDER BY t.transport_company_id
  `, [id]);

  const groups = rows.map(r => {
    const currentIds = Array.isArray(r.current_booking_ids) ? r.current_booking_ids : [];
    const lastIds = extractBookingIds(r.last_sent_data);
    const hasHistory = r.last_email_id != null;

    let status;
    let diff = null;
    let last_sent_booking_ids = null;
    let last_sent_at = null;
    let last_sent_email_id = null;

    if (!hasHistory) {
      status = 'chua_gui';
    } else {
      last_sent_at = r.last_sent_at;
      last_sent_email_id = r.last_email_id;
      last_sent_booking_ids = lastIds;

      if (r.last_mail_type === 'cancel' && r.last_mail_status === 'sent') {
        // Cancel is terminal — once a cancel has been sent for this transport,
        // status stays 'da_huy' until a new 'new' mail overrides it.
        status = 'da_huy';
      } else if (r.last_mail_type === 'new' && r.last_mail_status === 'sent') {
        if (currentIds.length === 0) {
          // Mailed once, then every booking moved/removed — DD must send HỦY.
          status = 'can_huy';
        } else {
          const d = diffSets(currentIds, lastIds);
          if (d.added.length === 0 && d.removed.length === 0) {
            status = 'da_gui';
          } else {
            status = 'co_thay_doi';
            diff = d;
          }
        }
      } else {
        // Latest mail failed (status='failed' or 'pending') — treat as no
        // successful history so DD can retry the send.
        status = 'chua_gui';
        last_sent_email_id = null;
        last_sent_at = null;
        last_sent_booking_ids = null;
      }
    }

    return {
      transport_company_id: r.transport_company_id,
      transport_name: r.tc_current_name || null,
      booking_ids: currentIds,
      status,
      last_sent_at,
      last_sent_email_id,
      last_sent_booking_ids,
      diff,
      // CP5.2 — only attach the snapshot when there's a successful 'new'
      // baseline (statuses that drive HỦY confirm UI). For chua_gui/da_huy
      // it's null since the cancel flow doesn't apply or no longer applies.
      last_sent_snapshot:
        (status === 'da_gui' || status === 'co_thay_doi' || status === 'can_huy')
          ? extractSnapshot(r.last_sent_data)
          : null,
    };
  });

  return { groups, job_code: job.job_code };
}

module.exports = { getMailStatusPerTransport, extractBookingIds };
