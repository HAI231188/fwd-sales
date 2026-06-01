// Shared job audit-history helper — single source of truth for writing
// rows into the `job_history` audit table.
//
// Canonical semantic: SKIP no-op writes. When the stringified old value
// equals the stringified new value, no row is written — phantom no-op rows
// are audit noise. (This unifies the two previously divergent copies that
// lived in routes/jobs.js and routes/accounting.js; the accounting copy
// always-wrote, but had no documented intent to record no-op events, so it
// was a simpler copy rather than a deliberate policy. See L24-class risk:
// same function name, two divergent semantics, one audit table.)
//
// Values are coerced to String (or null) so callers may pass timestamps,
// numbers, or strings uniformly; the columns are TEXT.
async function recordHistory(client, jobId, changedBy, fieldName, oldValue, newValue) {
  if (String(oldValue) === String(newValue)) return;
  await client.query(
    `INSERT INTO job_history (job_id, changed_by, field_name, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5)`,
    [jobId, changedBy, fieldName,
     oldValue != null ? String(oldValue) : null,
     newValue != null ? String(newValue) : null]
  );
}

module.exports = { recordHistory };
