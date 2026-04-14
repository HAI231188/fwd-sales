# Backend — API & Database Guide

> Read `../CLAUDE.md` first for architecture, modules, and golden rules.

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
