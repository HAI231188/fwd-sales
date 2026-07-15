# Backend — API & Database Guide

> Read `../CLAUDE.md` first for architecture, modules, and golden rules.

---

## ⚠️ Rule 0 — Independent AI review (Codex): verify before reporting "done"

**Every code change is independently reviewed line-by-line by a separate AI reviewer (Codex) before it is merged or deployed.** Your work WILL be audited, so never report a task as done until you have completed ALL of the following:

1. **Confirm every name exists in scope** — every new or referenced variable, import, and function must actually exist with the exact spelling used. Grep to verify. Half-applied edits that reference a non-existent binding are a common failure mode and will be caught.
2. **Run the checks** — `node --check <file>` on every edited backend file, and `npm run build` for any frontend change. Confirm both pass.
3. **Confirm no regressions** — the change must not break or contradict existing structure, conventions, or any rule in this file — especially the parallel-dashboard broadcast rule (L9/L10) and the desktop/mobile-parity rule (L26).
4. **Show concrete evidence** — present the actual grep results and the `node --check` / `npm run build` output, not just a claim of "done".

Treat "it should work" as insufficient: **show that it does.**

---

## ⚠️ Rule 0.6 — Trace-before-edit (no collateral breakage)

**Top-priority quality rule. Before editing ANY function, variable, API endpoint, DB column, shared constant, or component prop, you MUST first trace everything that depends on it — never edit blind.**

1. **Trace before you touch it.** Use the CodeGraph MCP tools (`codegraph_callers` / `codegraph_impact` / `codegraph_context`) to find every caller and dependent, PLUS a grep for the symbol name, BEFORE changing it. List every dependent site you found.
2. **Verify each dependent against your change.** For every site, confirm it still works — signature, return shape, field name, behavior.
3. **Applies to ALL edits** — not just signal-meaning / sibling-state changes (L5 stat=drilldown parity, L29 sibling-invariant transactions). The goal is that fixing one place never silently breaks another.
4. **Report the blast radius FIRST when it ripples.** If a change would reach many callers, present the full list of affected sites and the plan to handle each BEFORE editing — don't discover breakage after.
5. **After editing, prove it.** Build (`node --check` / `npm run build`) and confirm every traced dependent still compiles and behaves.

Reason: the single biggest source of wasted time here is a fix in one file surfacing a bug in another because the dependency map wasn't checked first — CodeGraph exists precisely to prevent this; **use it every time.**

---

## Tech stack

Node.js / Express. CommonJS (`require`/`module.exports`) throughout. No TypeScript, no ORM — raw SQL only via `pg` pool.

---

## Database access patterns

### Simple query
```js
const { rows } = await db.query(`SELECT ...`, [params]);
```

### Transaction (any multi-table write)
```js
const client = await db.pool.connect();
try {
  await client.query('BEGIN');
  // ... mutations ...
  await client.query('COMMIT');
  res.json(result);
} catch (err) {
  await client.query('ROLLBACK');
  res.status(500).json({ error: err.message });
} finally {
  client.release();  // always — even on success
}
```

### Date string sanitization exception
User-supplied dates (`startDate`, `endDate` from `req.query`) are trusted and interpolated directly into SQL — but only after `.replace(/'/g, '')` stripping. All other user input must use parameterized queries (`$1`, `$2`, …).

```js
${startDate ? `AND r.report_date >= '${startDate.replace(/'/g, '')}'` : ''}
```

---

## Role-based WHERE clause pattern

Sales users own their own data; lead role sees everything (or filtered by `userId` query param).

```js
const ownerCheck  = req.user.role === 'sales' ? 'AND sales_id = $2' : '';
const ownerParams = req.user.role === 'sales'
  ? [req.params.id, req.user.id]
  : [req.params.id];
```

When building dynamic condition lists (`conds`/`params` pattern):
```js
if (!isLead) { conds.push(`c.user_id = $${idx++}`); params.push(req.user.id); }
else if (userId) { conds.push(`c.user_id = $${idx++}`); params.push(userId); }
```

---

## Pipeline stage logic

### Stages
| Stage | Meaning |
|-------|---------|
| `new` | First contact, no engagement yet |
| `following` | Actively followed — interaction is `contacted` or `quoted` |
| `dormant` | No activity for 7+ days (auto) |
| `booked` | Won — has a booked quote (manual only) |

### `applyAutoTransitions(client, salesId)`
Defined at the top of `routes/pipeline.js`. Called **lazily** on every `GET /api/pipeline`. Runs inside the same transaction as the GET query — so no separate transaction needed.

Two transitions it applies:
1. `new`/`following` → `dormant`: `last_activity_date < CURRENT_DATE - INTERVAL '7 days'`
2. `new` → `following`: exists a `customers` row linked to this pipeline with `interaction_type IN ('contacted', 'quoted')`

Every stage change also inserts a row into `pipeline_history`.

### Detail modal shows resolved company info (2026-06-25)
`GET /api/pipeline/:id/detail` returns three resolved fields on the pipeline row so a **job-created customer** (zero sales interactions) still shows MST + address in `CustomerDetailModal`: `resolved_tax_code`, `resolved_address`, `resolved_full_name`. They mirror the customer-search COALESCE chain (`jobs.js:502-511`) — the latest name-matched JOB's `customer_tax_code`/`customer_address` (`customer_id OR LOWER(name)`, `deleted_at IS NULL`, non-empty, `ORDER BY created_at DESC LIMIT 1`) preferred over the pipeline invoice snapshot (`NULLIF(cp.tax_code/invoice_address,'')`); `resolved_full_name = NULLIF(cp.company_full_name,'')` (pipeline-only — jobs has no legal-name column). **Full priority chain = interaction → job → pipeline-invoice:** the modal applies `latest?.tax_code || pipeline.resolved_tax_code` (interaction wins, since a sales rep's manual entry is most current); the backend `resolved_*` covers the job→pipeline layers (it can't include the interaction layer — the detail query `GROUP BY cp.id` joins many `customers` rows, so `c.*` is ambiguous there). Display-only; no writes/backfill. `InfoRow` auto-hides empty values, so "Tên đầy đủ" hides when blank.

### `booked` is exempt from the date window (2026-06-24 fix)
`GET /api/pipeline` filters customers by `cp.last_activity_date` within the frontend's date range (`PipelineView` defaults to `'month'`). **`booked` is a terminal "won" stage and must NOT be time-boxed:** a customer booked via a job has `last_activity_date = NULL` (the L14 upsert at `jobs.js:~1539` sets `stage='booked'` + `updated_at` but **not** `last_activity_date`), and older bookings go stale — which silently hid ~47/48 booked customers from the rep's "Đã booking" list while the no-date-filter customer-data view still showed them. Fix: the WHERE is
```
WHERE cp.sales_id = $1 AND cp.deleted_at IS NULL AND ( cp.stage = 'booked' OR (<date conds>) )
```
**The `cp.sales_id = $1` owner filter stays OUTSIDE the OR (top-level AND) so it gates EVERY row** — booked or not. A booked row owned by sales B fails `cp.sales_id = $1(=A)` regardless of the OR, so a rep never sees another rep's booked customers. The booked-OR is omitted entirely when no date range is sent (WHERE unchanged). NEVER write `((sales_id=$1 AND date) OR stage='booked')` — that leaks other reps' booked customers.

**PENDING — Fix 2 (data-correctness, not yet done):** set `last_activity_date = NOW()` in the L14 booked upsert (`jobs.js:~1539`) so job-booked customers get a real activity date, and backfill the 28 existing `stage='booked' AND last_activity_date IS NULL` rows. Fix 1 (above) already makes booked visible regardless; Fix 2 also un-hides those rows from any *non-booked* date logic and from stat queries that read `last_activity_date`.

### Customer-name whitespace: trim-on-write + cleanup (2026-06-25)
The customer name is a `LOWER()`-match key across THREE tables — `customers.company_name`, `customer_pipeline.company_name`, `jobs.customer_name` (joined via `LOWER(j.customer_name)=LOWER(cp.company_name)` in ~13 sites: detail-modal `resolved_*`, `job_count`, the L14 `ON CONFLICT (sales_id, LOWER(company_name))`, etc.). Legacy writes stored leading/trailing whitespace (e.g. `"THẠCH HIỂN "`), which split the same customer across the match key.

**Trim-on-write (the safety net) — every backend path now `.trim()`s the name before storing/matching:** `jobs.js` POST `/` (single `customerName` const → jobs INSERT + L14 transfer-match + upsert + conflict key + notifications), `reports.js` `/quick-customer`, `customers.js` PUT `/:id` (+ its pipeline sync). `customer-pipeline.js` PATCH already trimmed. Frontend belt: `CreateJobModal`, `CustomerDetailModal`, `AddCustomerModal` trim on submit.

**One-off cleanup (idempotent, migrate path in `schema.sql`, runs BEFORE `backfill_pipeline.js`):** order matters — (1) trim the SOURCE `customers`; (2) **soft-delete** whitespace pipeline rows that have a trimmed-equal CLEAN sibling under the same `sales_id` (these are backfill artifacts — trimming them would collide on the partial unique index `(sales_id, LOWER(company_name)) WHERE deleted_at IS NULL`); (3) trim remaining lone whitespace pipeline rows; (4) trim `jobs`.

**The trap that cost a redeploy — `backfill_pipeline.js` re-propagates from `customers`.** `start.js` runs the schema migrate THEN `backfill_pipeline.js`, which derives `customer_pipeline` rows from `customers.company_name`. The FIRST cleanup deploy trimmed `customer_pipeline`+`jobs` but NOT `customers`, so the backfill's `LOWER(" X") ≠ LOWER("X")` "missing" check failed to match the cleaned row and re-INSERTed 17 whitespace duplicates. Fix: trim the `customers` source AND make `backfill_pipeline.js` **TRIM-aware** (`LOWER(TRIM(...))` in every group/match/insert in `STAGE_CTES` + Steps 0/1/2; Step 2 also gained `cp.deleted_at IS NULL`). **Rule:** when cleaning a denormalized/derived column, clean the SOURCE table and audit every job that re-derives it (`backfill_pipeline.js` here) in the same change — trimming only the derived copy lets the re-derivation undo the cleanup (or spawn dupes). Verified live: 0 whitespace in all three tables, 17 artifacts soft-deleted, backfill logs `Inserted 0`, «THẠCH HIỂN» `job_count=2` + MST intact, a hypothetical re-run trims/soft-deletes 0.

---

## Customer code generation

- Format: `[4-digit daily seq][DDMMYY]` — e.g., `0001130426`
- Only generated for the **first pipeline entry** of a new company for a user
- Uses `customer_code_seq` table with atomic increment:

```sql
INSERT INTO customer_code_seq (seq_date, last_seq) VALUES (CURRENT_DATE, 1)
ON CONFLICT (seq_date) DO UPDATE SET last_seq = customer_code_seq.last_seq + 1
RETURNING last_seq
```

- Subsequent interactions with the same company: `customer_code = NULL`

---

## KPI / Stats query structure (`routes/stats.js`)

All stats run as a `Promise.all` of independent queries. Key param-building pattern:

```js
const conds = [];
const params = [];
let idx = 1;

if (!isLead) { conds.push(`c.user_id = $${idx++}`); params.push(req.user.id); }
else if (userId) { conds.push(`c.user_id = $${idx++}`); params.push(userId); }
if (startDate) { conds.push(`r.report_date >= $${idx++}`); params.push(startDate); }
if (endDate)   { conds.push(`r.report_date <= $${idx++}`); params.push(endDate); }

const WHERE = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
const AND   = conds.length ? 'AND' : 'WHERE';
```

### Follow-up stat queries (Chờ Follow — three groups)
Each group uses its own isolated `wConds`/`wParams`/`wi` to build the WHERE clause cleanly.

| Group | Condition |
|-------|-----------|
| `follow_today` | `c.follow_up_date = CURRENT_DATE` |
| `follow_upcoming` | `c.follow_up_date > CURRENT_DATE AND c.follow_up_date <= CURRENT_DATE + INTERVAL '3 days'` |
| `overdue` | `c.follow_up_date < CURRENT_DATE` |

All three groups share the same exclusion filters:
- `c.interaction_type != 'saved'`
- `c.follow_up_completed = FALSE`
- The NOT EXISTS correlated subquery (see below)

### Follow-up completion exclusion (NOT EXISTS subquery)
Used in all three follow-up stat queries and in the `waiting_follow_up` drilldown:

```sql
NOT EXISTS (
  SELECT 1 FROM customer_interaction_updates ciu
  WHERE ciu.customer_id = c.id
    AND ciu.follow_up_date IS NOT NULL
    AND ciu.completed = TRUE
    AND NOT EXISTS (
      SELECT 1 FROM customer_interaction_updates ciu2
      WHERE ciu2.customer_id = c.id
        AND ciu2.follow_up_date IS NOT NULL
        AND ciu2.created_at > ciu.created_at
        AND ciu2.completed = FALSE
    )
)
```

Meaning: a customer is excluded only if its **latest follow-up update is completed** (no uncompleted update exists after the completed one).

---

## Follow-up completion — two levels

| Level | Table | Endpoint |
|-------|-------|----------|
| Customer-level | `customers.follow_up_completed` + `follow_up_result` | `PATCH /api/pipeline/customers/:id/follow-up-complete` |
| Update-level | `customer_interaction_updates.completed` + `completion_note` | `PATCH /api/pipeline/customers/updates/:id/complete` |
| Undo update | same table | `PATCH /api/pipeline/customers/updates/:id/uncomplete` |

---

## Customer search params (`GET /api/customers`)

| Param | Behaviour |
|-------|-----------|
| `search` | ILIKE match on `company_name` OR `contact_person` |
| `excludeSaved=true` | Restricts to `interaction_type IN ('contacted', 'quoted')` |
| `interactionType` | Exact match filter |
| `startDate` / `endDate` | Filter by `r.report_date` |
| `userId` | Lead-only filter by sales user |
| `limit` | Capped at 50 |

`excludeSaved` is **only applied when explicitly `=== 'true'`** — search alone does not exclude saved customers.

---

## Drilldown endpoint (`GET /api/stats/drilldown/:type`)

Uses two reusable SELECT fragments:
- `quoteSelect` — joins quotes → customers → reports → users
- `custSelect` — joins customers → reports → users, aggregates quote_count

`waiting_follow_up` type uses a `DISTINCT ON (c.user_id, LOWER(c.company_name))` query to deduplicate one row per (user, company), picking the row with the latest `follow_up_date`. Date filter: `c.follow_up_date <= CURRENT_DATE + INTERVAL '3 days'` (includes upcoming group).
