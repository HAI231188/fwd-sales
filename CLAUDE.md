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

### L6 — SQL alias names are the API contract; never rename them during debugging

This codebase has no TypeScript, no API schema validation, no serializers. The SQL `AS alias` name is consumed **directly** by field name in every frontend component. Renaming an alias silently returns `undefined` in JS — no error is thrown, the `|| ''` fallback masks it, and the UI appears to work while showing blank data.

**The bug:** Adding debug visibility to `GET /customer-search` renamed `customer_address → cust_address` and `customer_tax_code → cust_tax_code`. The frontend's `selectCustomer(c)` read `c.customer_address` → `undefined` → `''`. Auto-fill silently broke with no console error.

**Compounding factor:** The original query also looked in the wrong table — `jobs.customer_address` (rarely filled) instead of `customers.address` (filled by sales via CRM). Two bugs layered on each other made it hard to diagnose.

**Rules:**
1. When debugging a query, **add** new fields alongside existing ones — never rename or remove existing aliases.
2. Safe pattern: `SELECT existing_col, existing_col AS _debug_raw FROM ...` — keeps the contract intact, adds visibility.
3. Remove all `_debug_*` fields before committing.
4. When writing a new query, verify alias names match exactly what the frontend reads before shipping.
5. When a field is NULL/empty and shouldn't be, check **which table the data actually lives in** before assuming the JOIN or subquery is broken.

**Known high-risk aliases** (consumed directly by frontend — never rename):
- `GET /api/jobs/` → `tk_notes`, `truck_delivery_location`, `cus_name`, `ops_name`, `tk_status`, `tq_datetime`, `truck_completed_at`
- `GET /api/jobs/stats` → `total_pending`, `warn_soon`, `delete_requests`, `total_managing`, `sap_han`, `qua_han`
- `GET /api/jobs/customer-search` → `customer_address`, `customer_tax_code`, `pipeline_id`, `sales_id`, `sales_name`

### L8 — Detail modals must display ALL database fields comprehensively

**Root cause pattern:** When adding new fields to jobs/job_tk/job_truck/job_ops_task tables, developers often update only the form and grid but forget the detail modal. Over time the modal falls behind schema by 10+ fields, forcing users to dig through multiple UIs to see full info.

**Rules:**
1. If a field exists in the database and the user fills it in, the detail modal must display it. No exceptions.
2. Whenever adding a new column to `jobs`/`job_tk`/`job_truck`/`job_ops_task`/`job_containers`/`job_assignments`, update `JobDetailModal.jsx` in the **same commit**.
3. Detail modals show ALL fields in readonly form — editing happens in dashboards, not in the modal.
4. Format convention: empty/null fields show `—` (em dash), not blank. Timestamps use `vi-VN` locale.
5. Logical sections: Thông tin chung / Lô hàng / Phân công / Tờ khai / Vận chuyển / Công việc OPS / Lịch sử thay đổi.

Also applies to `CustomerDetailModal` in the Sales module.

---

### L7 — Seed scripts must never DELETE users outside their own scope

**Root cause pattern:** `seed_users.js` had a broad `DELETE FROM users WHERE code != ALL(sales_codes)` that deleted any user not in the sales list. When the LOG module added cus/ops users with FK references (`ai_assignment_logs.assigned_user_id`), the DELETE failed with a FK constraint violation, crashed `npm run db:seed`, and Railway entered a restart loop ("Application failed to respond").

**Rules:**
1. Seed scripts must scope DELETE by role (`role IN ('sales','lead')`) not by exclusion of codes — never assume the users table only contains your module's users.
2. Each module's seed script only manages its own roles — do not delete users that belong to other modules.
3. When adding a new module with new roles, audit all existing seed scripts to confirm they won't accidentally delete the new users.
4. Test `npm run db:seed` locally after adding new roles before pushing to production.

---

### L9 — Full-system audit required before every commit

**Root cause pattern:** When adding or modifying database fields, API endpoints, or shared components, changes often only cover the primary touch points. Related queries, UI components, and modal displays get missed, causing inconsistency bugs (e.g. field saved but not displayed anywhere, API returns field but frontend ignores it, modal shows field but list view doesn't).

**Rules (mandatory before every commit):**

1. **When modifying a database field (add/rename/drop column):**
   - Audit ALL SQL queries in `backend/src/routes/` that touch that table — confirm the field is in SELECT, INSERT, UPDATE, DELETE as needed
   - Audit ALL frontend components that destructure objects from that table — confirm the new field is rendered or at least not breaking

2. **When adding a new API endpoint or modifying an existing one:**
   - List all frontend callers using grep (`api/index.js`, component files)
   - Confirm all callers handle the new response shape

3. **When modifying shared components (e.g. JobDetailModal, CustomerDetailModal):**
   - List all pages that import and use the component
   - Confirm prop changes don't break any caller

4. **Before running `git commit`:**
   - Produce a summary table: "Files touched | Related files checked | Gaps found"
   - If any gap found, fix in the same commit
   - Never commit with known gaps

5. Apply to both frontend and backend changes equally.

Also applies to all modules: Sales, LOG, and future (OVS, PRI, ACCOUNTING).

---

### L10 — Fix broadcast to similar patterns

**Root cause pattern:** When fixing a bug or adding a feature in one role/component, only that component gets updated. Other dashboards with the same structure (TP/CUS/OPS/DieuDo) silently remain broken or missing the feature — discovered later by users, requiring a second round of fixes.

**Rules:**
1. When fixing a pattern (e.g. clickable stat cards, inline editing, drilldown modal, button visibility), audit all similar components (other dashboards, other roles) in the same commit.
2. Dashboards with parallel structure (TP/CUS/DieuDo/OPS) should have features applied consistently unless explicitly role-specific.
3. Never fix in isolation when the pattern repeats. Grep for the same pattern across the codebase before committing.
4. Ask: "Does any other dashboard/component do the same thing?" If yes, apply the fix there too.

Also applies to backend route handlers with parallel structure (e.g. PATCH /tk, PATCH /truck, PUT /:id).

---

### L11 — Every job/customer list must have clickable rows

**Root cause pattern:** Drilldown modals, stat card drilldowns, and search results repeatedly ship without row-click handlers. Users see a list of jobs/customers but have no way to see details — they must navigate back, find the item in the main grid, and click from there.

**Rules (mandatory for all modules — LOG, Sales, future OVS/PRI/CUS/ACCOUNTING):**
1. ANY component that displays a list of jobs MUST make each row clickable to open `JobDetailModal`.
2. ANY component that displays a list of customers MUST make each row clickable to open `CustomerDetailModal`.
3. Applies to: drilldown modals, stat card drilldowns, search results, notification lists, activity lists, history views, filtered lists.
4. Inline action buttons (Approve/Reject, Edit, Delete, etc.) inside the row must use `event.stopPropagation()` to prevent triggering the row-level modal open.
5. Hover state: add `cursor: pointer` and subtle background change to signal clickability.
6. Never ship a job/customer list view without clickable rows — this is a core UX contract.

---

### L12 — Debug with real data before fixing, and beware of default values

**Root cause pattern:** Bugs in data display (stat cards, modals, lists) often trigger assumption-based fixes that patch symptoms but miss the actual data shape. Schema default values can also leak into queries in unexpected ways (e.g. `cus_confirm_status` defaults to `'pending'`, causing truck-only jobs without `cus_id` to match CUS pending queries).

**Example:** "CUS chưa nhận = 0" bug took 3 fix iterations. Only after querying real DB data did it become clear there were no actual CUS jobs waiting — the counts were correct all along. A different "1 showing unexpectedly" symptom earlier was caused by schema default values bleeding into queries.

**Rules (mandatory for all data display bugs):**

1. **DEBUG WITH REAL DATA FIRST:**
   - Run a `SELECT` query on the actual database before writing any fix code
   - Report query results to the user before writing fix code
   - Confirm the "bug" is actually wrong behavior, not correct behavior on empty/new data

2. **WATCH DEFAULT VALUES:**
   - When a table has a `DEFAULT` value (e.g. `cus_confirm_status DEFAULT 'pending'`), any row created without that column will have that default — even when the field isn't semantically applicable
   - Always consider: "could this default value match queries it shouldn't?"
   - Common fix: add explicit NULL guards (e.g. `AND cus_id IS NOT NULL`) or use conditional defaults

3. **REPEATED BUG RULE:**
   - If a bug has been "fixed" once and returns, L12 applies with extra rigor
   - Never skip the real-data debug step for repeat bugs

4. Applies to: stat cards, drilldown modals, list views, dashboards, search results, any data-display component.

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
