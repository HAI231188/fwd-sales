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

  // CP5.3 — composite-key query: each (transport_company_id, mail_group_id)
  // pair is one card in Vùng 2. mail_group_id IS NULL → the forming batch
  // (new bookings not yet mailed). mail_group_id IS NOT NULL → a sent batch
  // (the value equals the email_history.id of the 'new' mail that first
  // shipped this batch).
  //
  // Sent batches are also pulled from email_history even when they currently
  // have zero alive bookings — those surface as 'can_huy' ghost cards so DD
  // can still send a HỦY.
  const { rows } = await db.query(`
    WITH all_keys AS (
      SELECT DISTINCT tb.transport_company_id, tb.mail_group_id
        FROM truck_bookings tb
       WHERE tb.job_id = $1 AND tb.deleted_at IS NULL
         AND tb.transport_company_id IS NOT NULL
      UNION
      SELECT DISTINCT eh.recipient_transport_company_id, eh.id
        FROM email_history eh
       WHERE eh.job_id = $1 AND eh.deleted_at IS NULL
         AND eh.mail_type = 'new' AND eh.status = 'sent'
         AND eh.recipient_transport_company_id IS NOT NULL
    )
    SELECT
      k.transport_company_id,
      k.mail_group_id,
      tc.name AS tc_current_name,
      COALESCE((
        SELECT json_agg(tb.id ORDER BY tb.id)
          FROM truck_bookings tb
         WHERE tb.job_id = $1 AND tb.deleted_at IS NULL
           AND tb.transport_company_id = k.transport_company_id
           AND tb.mail_group_id IS NOT DISTINCT FROM k.mail_group_id
      ), '[]'::json) AS current_booking_ids,
      eh_orig.id              AS orig_mail_id,
      eh_orig.created_at      AS orig_sent_at,
      eh_orig.last_sent_data  AS orig_last_sent_data,
      eh_cancel.id            AS cancel_mail_id,
      eh_cancel.created_at    AS cancel_sent_at,
      eh_cancel.status        AS cancel_status,
      CASE
        WHEN k.mail_group_id IS NULL THEN NULL
        ELSE (
          SELECT COUNT(*)::int
            FROM email_history eh2
           WHERE eh2.job_id = $1
             AND eh2.recipient_transport_company_id = k.transport_company_id
             AND eh2.mail_type = 'new'
             AND eh2.status   = 'sent'
             AND eh2.deleted_at IS NULL
             AND eh2.id <= k.mail_group_id
        )
      END AS batch_number
    FROM all_keys k
    LEFT JOIN transport_companies tc ON tc.id = k.transport_company_id
    LEFT JOIN email_history eh_orig ON eh_orig.id = k.mail_group_id
    LEFT JOIN LATERAL (
      SELECT id, created_at, status
        FROM email_history
       WHERE job_id = $1
         AND mail_type = 'cancel'
         AND deleted_at IS NULL
         AND k.mail_group_id IS NOT NULL
         AND (last_sent_data->>'mail_group_id')::int = k.mail_group_id
       ORDER BY created_at DESC, id DESC LIMIT 1
    ) eh_cancel ON true
    ORDER BY k.transport_company_id, k.mail_group_id NULLS LAST
  `, [id]);

  const groups = rows.map(r => {
    const currentIds = Array.isArray(r.current_booking_ids) ? r.current_booking_ids : [];
    const isForming = r.mail_group_id == null;
    const lastIds = !isForming ? extractBookingIds(r.orig_last_sent_data) : [];

    let status;
    let diff = null;
    let last_sent_booking_ids = null;
    let last_sent_at = null;
    let last_sent_email_id = null;

    if (isForming) {
      status = 'chua_gui';
    } else {
      last_sent_at         = r.orig_sent_at;
      last_sent_email_id   = r.orig_mail_id;
      last_sent_booking_ids = lastIds;

      const cancelled = r.cancel_mail_id != null && r.cancel_status === 'sent';
      if (cancelled) {
        // Terminal: this batch is closed.
        status = 'da_huy';
      } else if (currentIds.length === 0) {
        // Sent batch with no current members — DD must send HỦY.
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
    }

    return {
      transport_company_id: r.transport_company_id,
      transport_name: r.tc_current_name || null,
      mail_group_id: r.mail_group_id,
      batch_number: r.batch_number,
      booking_ids: currentIds,
      status,
      last_sent_at,
      last_sent_email_id,
      last_sent_booking_ids,
      diff,
      // CP5.2 — only attach the snapshot when there's a successful 'new'
      // baseline (statuses that drive HỦY confirm UI). For chua_gui/da_huy
      // it's null since the cancel flow doesn't apply or no longer applies.
      // CP5.3 — snapshot pulled from the origin 'new' row keyed by
      // mail_group_id (the column changed name in the query rewrite).
      last_sent_snapshot:
        (status === 'da_gui' || status === 'co_thay_doi' || status === 'can_huy')
          ? extractSnapshot(r.orig_last_sent_data)
          : null,
    };
  });

  return { groups, job_code: job.job_code };
}

module.exports = { getMailStatusPerTransport, extractBookingIds };
