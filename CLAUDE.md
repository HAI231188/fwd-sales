# CLAUDE.md — SLB Global Logistics Internal Management System

> **READ THIS FILE FIRST at the start of every session.**
> Then read `frontend/src/CLAUDE.md` (UI patterns) and/or `backend/CLAUDE.md` (API & DB patterns) for the area you're working in.

---

## 1. Project Vision

**SLB Global Logistics** — internal management system, starting with the Sales team.

**Expansion roadmap:**
- Phase 1 (current): Sales team — daily reporting, customer pipeline, KPI dashboard
- Phase 2: LOG (operations), OVS (overseas agents), CUS (customer service)
- Phase 3: PRI (pricing), ACCOUNTING, SHIPMENT tracking
- Phase 4: AI features — AI_QUOTE (auto price suggestions), AI_MAIL (draft follow-up emails)

**Primary language of the UI:** Vietnamese. All user-facing labels, toast messages, and button text are in Vietnamese. Code identifiers (variables, functions, DB columns) are in English.

---

## 2. Architecture

```
fwd-sales/
├── backend/              # Node.js / Express API server
│   ├── CLAUDE.md         # API patterns, DB access rules, business logic
│   ├── start.js          # Production entry: migrate → backfill → build frontend → start
│   ├── server.js         # Starts express app on PORT
│   └── src/
│       ├── app.js        # Express app, route mounting, static serving
│       ├── db/
│       │   ├── index.js            # pg Pool singleton
│       │   ├── schema.sql          # Full DB schema (idempotent — uses IF NOT EXISTS)
│       │   ├── migrate.js          # Runs schema.sql on every deploy
│       │   └── backfill_pipeline.js # Idempotent — creates pipeline rows from existing customers
│       ├── middleware/
│       │   └── auth.js   # requireAuth — JWT verification, attaches req.user
│       └── routes/
│           ├── auth.js       # POST /api/auth/login, GET /api/auth/me, POST /api/auth/change-password
│           ├── reports.js    # CRUD + POST /reports/quick-customer
│           ├── customers.js  # CRUD for customers
│           ├── quotes.js     # CRUD for quotes
│           ├── stats.js      # GET /stats, GET /stats/drilldown/:type
│           └── pipeline.js   # Pipeline view, interaction updates, follow-up completion
└── frontend/             # React 18 / Vite SPA
    └── src/
        ├── CLAUDE.md       # Component patterns, design tokens, UI business logic
        ├── App.jsx         # Router, AuthContext, ProtectedRoute
        ├── api/index.js    # All API calls (axios instance with JWT interceptor)
        ├── index.css       # Global CSS variables and utility classes
        ├── pages/
        │   ├── Login.jsx
        │   ├── LeadDashboard.jsx   # role=lead only
        │   ├── SalesDashboard.jsx  # role=sales only
        │   ├── ReportDetail.jsx
        │   └── ChangePassword.jsx
        └── components/
            ├── Navbar.jsx
            ├── StatCard.jsx
            ├── DateFilter.jsx
            ├── DrilldownModal.jsx
            ├── PipelineView.jsx
            ├── CustomerDetailModal.jsx  # Main modal: customer info, quotes, interaction thread
            ├── CustomerCard.jsx
            ├── QuoteForm.jsx
            └── AddCustomerModal.jsx
```

**Deployment:** Railway — single service runs `backend/start.js` which builds the frontend, runs migrations, then serves everything from Express. No separate frontend service.

**Local dev:**
- Backend: `cd backend && npm run dev` (nodemon, port 3001)
- Frontend: `cd frontend && npm run dev` (Vite, port 5173, proxied to 3001)

---

## 3. Module List

### Current modules

| Module | Routes | Key Files |
|--------|--------|-----------|
| AUTH | `/api/auth/*` | `routes/auth.js`, `middleware/auth.js` |
| REPORT | `/api/reports/*` | `routes/reports.js`, `ReportDetail.jsx` |
| CUSTOMER | `/api/customers/*` | `routes/customers.js`, `CustomerCard.jsx` |
| QUOTE | `/api/quotes/*` | `routes/quotes.js`, `QuoteForm.jsx` |
| PIPELINE | `/api/pipeline/*` | `routes/pipeline.js`, `PipelineView.jsx`, `CustomerDetailModal.jsx` |
| DASHBOARD | `/api/stats/*` | `routes/stats.js`, `LeadDashboard.jsx`, `SalesDashboard.jsx` |
| INTERACTION | (part of pipeline) | `CustomerDetailModal.jsx` — threaded updates, follow-up completion |

### Future modules (do not build yet)

| Module | Purpose |
|--------|---------|
| SALES_OVS | Overseas sales team, same structure as Sales |
| LOG | Operations team — shipment execution, documents |
| CUS | Customer service — post-booking queries |
| PRI | Pricing team — rate management, quote approvals |
| ACCOUNTING | Invoice tracking, payment status |
| SHIPMENT | Shipment lifecycle tracking linked to booked quotes |
| AI_QUOTE | Auto-generate price options from route + cargo inputs |
| AI_MAIL | Draft follow-up emails from interaction notes |

---

## 4. File Naming

- React components: `PascalCase.jsx` (e.g., `CustomerDetailModal.jsx`)
- Pages: `PascalCase.jsx` in `src/pages/`
- Backend routes: `snake_case.js` (e.g., `pipeline.js`)
- DB scripts: `snake_case.js` (e.g., `backfill_pipeline.js`)
- DB tables: `snake_case` plural (e.g., `customers`, `customer_pipeline`)
- DB columns: `snake_case` (e.g., `company_name`, `follow_up_date`)
- FK columns: `<table_singular>_id` (e.g., `report_id`, `pipeline_id`)

---

## 5. Golden Rules

1. **Never hard-delete customer or report data.** If deletion is needed, add `deleted_at` (soft delete). Current `DELETE` endpoints on customers are the only exception.

2. **Always maintain an audit trail.** Stage changes → `pipeline_history`. Interaction updates have `created_by`.

3. **Schema changes must be idempotent.** All DDL goes in `schema.sql` using `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`. Never write one-off migration scripts.

4. **Transactions for multi-table writes.** Any mutation touching more than one table uses `BEGIN/COMMIT/ROLLBACK` with `client.release()` in `finally`.

5. **Mobile-first UI.** Modals and cards must be usable at 375px. Use `flexWrap`, relative widths, readable font sizes.

6. **Vietnamese UI text, English code.** All button labels, toast messages, headers, placeholders in Vietnamese. All identifiers in English.

7. **State lifting for stable React state.** If child state resets on React Query invalidations, lift to nearest stable parent. See `FollowUpWidget` / `UpdateRow` / `InteractionFollowUpWidget` pattern in `frontend/src/CLAUDE.md`.

8. **No speculative features.** Only build what is explicitly asked for.

---

## 5a. Critical Lessons Learned

### L1 — Multi-row customer pattern
One `company_name` can have **multiple rows in the `customers` table** (one per report interaction). Never assume one customer = one row. When aggregating (counts, follow-up dates, quote counts) across a company, always JOIN across all rows sharing the same `(user_id, LOWER(company_name))` pair, or use a correlated subquery that spans all matching rows.

### L2 — Two follow-up sources; always check both
The follow-up system has **two independent sources**:

| Source | Table | Date column | Completion flag |
|--------|-------|-------------|-----------------|
| Customer-level | `customers` | `follow_up_date` | `follow_up_completed = FALSE` |
| Update-level | `customer_interaction_updates` | `follow_up_date` | `completed = FALSE` |

Every follow-up stat query and every drilldown filter **must check both** via `OR EXISTS` (for counts) or `UNION ALL` (for row-level results). Checking only `customers.follow_up_date` will silently miss customers who only have CIU follow-up dates set.

Also: `c.interaction_type != 'saved'` must only guard the **customer-level branch** of the OR — not the top-level WHERE. A 'saved' customer with a CIU follow-up is still a valid pending task.

### L3 — Never use `toISOString()` for date comparisons in the frontend
`new Date().toISOString().slice(0, 10)` returns the **UTC date**. In Vietnam (UTC+7), after ~5 pm local time the UTC date is already tomorrow, silently bucketing today's follow-ups into "upcoming" or "overdue".

**Always** compute date strings using local time parts:
```js
const localDateStr = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};
const today = localDateStr(new Date());
```
Apply the same local-date extraction when parsing server date strings for comparison.

### L4 — CHỜ FOLLOW drilldown uses UNION ALL, not DISTINCT ON
The `waiting_follow_up` drilldown returns **one row per follow-up task**, not one row per company. A company with two pending CIU dates (e.g., 18/04 and 20/04) appears **twice** — once in "Hôm nay" and once in "7 ngày tới". This is intentional: each row is an action item.

The query is a `UNION ALL` of:
- **Source A**: `customers.follow_up_date` (deduplicated per pipeline + date via `DISTINCT ON`)
- **Source B**: `customer_interaction_updates.follow_up_date` (one row per CIU)

Do not collapse back to DISTINCT ON per company — that was the original bug.

### L5 — Stat query and drilldown must use identical WHERE logic
If the stat counts a customer in "today" using condition X, the drilldown must also include that customer using the same condition X. Any divergence (extra filters, missing OR branch, different date range) causes the displayed count to disagree with the modal rows — which is a confusing and hard-to-debug UX bug.

Rule: when changing a stat query condition, always update the matching drilldown condition in the same commit, and vice versa. Also note that **follow-up stats must NOT be filtered by `r.report_date`** — follow-up obligations are independent of when the report was filed.

---

## 6. Session Start Checklist

1. Read this file.
2. Read `frontend/src/CLAUDE.md` and/or `backend/CLAUDE.md` for the area you're working in.
3. `git status` and `git log --oneline -10`.
4. Read the specific file you're about to change — don't modify what you haven't read.

---

## 7. Deployment

```bash
git add <changed files>
git commit -m "<descriptive message>"
git push origin master
railway up --detach
```

Railway runs `start.js`: migrations → pipeline backfill → frontend build → Express server.

---

## 8. ECC Usage (Everything Claude Code)

### Before building any new feature or module

1. Run `/plan` to create an implementation blueprint
2. Use the **architect** agent for new database schemas
3. Use the **database-reviewer** agent to review schema before migration

### After building any feature

1. Run `/code-review` using the **typescript-reviewer** and **code-reviewer** agents
2. Run `/security-scan` before every major deploy
3. Run `/update-docs` to keep CLAUDE.md current
4. Run `/learn` to extract patterns from the session

### Skills — load when needed

| Skill | When to load |
|-------|-------------|
| `postgres-patterns` | Writing complex queries or optimizations |
| `api-design` | Adding new API endpoints |
| `database-migrations` | Writing schema changes |
| `backend-patterns` | Adding new backend routes |
| `cost-aware-llm-pipeline` | Building AI automation features (Phase 2+) |
| `continuous-learning-v2` | Ongoing pattern extraction |

### Agents — always available

| Agent | Purpose |
|-------|---------|
| `planner` | Feature planning |
| `architect` | System design |
| `database-reviewer` | Schema review |
| `typescript-reviewer` | React component review |
| `code-reviewer` | General code review |
| `build-error-resolver` | Fix Railway deploy errors |
| `security-reviewer` | Pre-deploy security audit |
| `doc-updater` | Documentation sync |
| `refactor-cleaner` | Dead code removal |

### Token optimization

- Keep under 10 MCPs enabled at a time
- Run `/compact` at logical breakpoints
- Use `/clear` between unrelated tasks
- Run `/learn` at the end of each major session
