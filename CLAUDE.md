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
| BBBG | `GET /api/jobs/:id/bbbg-data`, `POST /api/jobs/:id/bbbg-pdf` | `services/bbbg-pdf.js`, `BBBGModal.jsx`, `LogDashboardDieuDo.jsx` — generate-on-demand delivery handover PDF (no persistence). Role-gated to `truong_phong_log` + `dieu_do`. Optional fonts at `backend/src/assets/fonts/Roboto-{Regular,Bold,Italic}.ttf`; falls back to Helvetica with a warning if absent. |
| TRANSPORT | `/api/transport-companies/*` | `routes/transport.js`, `TransportPicker.jsx`, `TransportFormModal.jsx`, `TransportCompaniesPage.jsx` (route `/transport-companies`) — Quản lý tên vận tải. Picker-only inline UI for DieuDo grid + JobDetailModal; full management table at `/transport-companies` (Navbar link visible only to `truong_phong_log` + `dieu_do`). `GET /` returns `job_count` (LEFT JOIN job_truck) so the table can show "Số job đã chạy". `job_truck` carries both `transport_company_id` (FK, ON DELETE SET NULL) and `transport_name` (snapshot — survives company deletion or rename). Read-open to all authenticated users; write (POST/PATCH/DELETE) gated to `truong_phong_log` + `dieu_do`. Soft-delete only. Case-insensitive UNIQUE on name (`LOWER(name)`). |
| TRUCK_BOOKINGS | `/api/truck-bookings/*` + `/api/jobs/:id/truck-booking-status` + `/api/jobs/:id/available-containers` + `/api/jobs/:id/past-delivery-locations` | `routes/truck-bookings.js`, `services/job-completion.js`, `BookingModal.jsx`, `utils/truckBookingStatus.js`, "Quản lý đặt xe" section + summary main grid in `LogDashboardDieuDo.jsx`. **Phase 4**: DD dashboard fully migrated — main tabs filter by `truck_booking_status`, main grid is read-only (booking edits via Quản lý đặt xe), `queryDieuDoStaffStats` + all `staff_dd_*` / `dd_*` drilldown filters source from `get_truck_booking_status()`, BBBG endpoint reads from `truck_bookings` (earliest by planned_datetime), `checkAndCompleteJob` lives in `services/job-completion.js` and is called from `PATCH /api/truck-bookings/:id` on vehicle_number transitions. **Removed**: `PATCH /api/jobs/:id/truck` route, `truck_booked` sync block in `PATCH /:id/tk`, `updateJobTruck` API client, inline truckMut on DD dashboard + JobDetailModal. `job_truck` table still in schema but no longer written by app code — drop deferred to a future phase. `schema.sql` (`truck_bookings`, `truck_booking_containers`, `get_truck_booking_status()`) — multi-truck booking system. One job → N bookings → M containers via the link table (UNIQUE container_id enforces 1 cont = 1 active booking). **Endpoints:** `GET /api/truck-bookings?job_id=N` (any auth) → list with `containers[]`; `POST /api/truck-bookings` (DD + TP) → create with `{job_id, transport_company_id, planned_datetime, delivery_location, cost?, container_ids[], notes?}`, snapshots `transport_name` from `transport_companies` (L13), validates carrier live + containers belong to job + no double-booking; `PATCH /api/truck-bookings/:id` (DD + TP) → updates editable fields, re-snapshots transport_name on carrier change, `vehicle_number` NULL→value sets `completed_at = NOW()` (reverse clears it); `DELETE /api/truck-bookings/:id` (DD + TP) → **Option B**: soft-deletes the booking row + HARD-deletes the link rows (containers become available because `UNIQUE(container_id)` on the link is unconditional). `GET /api/jobs/:id/truck-booking-status` returns `{status}` from the plpgsql function; `GET /api/jobs/:id/available-containers` (DD + TP) returns containers of this job not in any live booking. **`job_truck` is deprecated** (POST `/api/jobs` no longer seeds it; PATCH `/:id/truck` + PATCH `/:id/tk` truck_booked sync block carry deprecation comments). Removal in a later phase once Phase 3 UI migrates. See **L20**. |
| CUSTOMER_PIPELINE | `/api/customer-pipeline/*` | `routes/customer-pipeline.js`, `CustomerEditModal.jsx`, `CustomerDataPage.jsx` (route `/customers`) — Data khách hàng. Admin (TP + lead) management page: list, edit (company_name + invoice fields + sales_id), soft-delete (TP only). GET returns sales JOIN + job_count (LOWER(j.customer_name)=LOWER(cp.company_name)). PATCH detects sales_id change → applies L14 transfer pattern (DELETE old pipeline + children, UPSERT under new sales, notifications, audit). Mounted at `/api/customer-pipeline` not `/api/customers` to avoid collision with `routes/customers.js` PUT/DELETE on the `customers` (interaction) table. Navbar link visible only to `truong_phong_log` + `lead`. Soft delete via `customer_pipeline.deleted_at` — partial unique index `idx_pipeline_sales_company_active WHERE deleted_at IS NULL` lets the same (sales, company) be re-created post-delete; the L14 UPSERT in `routes/jobs.js` POST `/` matches via `ON CONFLICT (sales_id, LOWER(company_name)) WHERE deleted_at IS NULL`. |
| EMAIL_SYSTEM | `/api/email/*` + `/api/users/me/gmail-setup` | `schema.sql` (`users.gmail_address`, `users.gmail_app_password_encrypted`, `users.gmail_display_name`, `email_history` table), `utils/encryption.js` (AES-256-GCM, key from `GMAIL_ENCRYPTION_KEY` env var = 64 hex chars), `services/email-sender.js`, `routes/email.js`, `routes/users.js`, `ChangePassword.jsx` Gmail card, `TruckPlanningModal.jsx` Vùng 2 send wiring. **CP1**: DB columns + `email_history` audit table (soft-deletable, JSONB `last_sent_data` snapshot for "có thay đổi" diff). **CP2**: AES-256-GCM helper + `/api/users/me/gmail-setup` GET/PUT/DELETE + extended `/change-password` page. **CP3**: nodemailer Gmail SMTP send via `POST /api/email/send-planning` (DD+TPL), `GET /api/email/history` (DD+TPL+lead), rendered Vietnamese subject + body for `mail_type ∈ ('new','cancel')`. **Domain whitelist**: `@gmail.com`, `@googlemail.com`, `@slbglobal.com` (Google Workspace). `email_cc` parsed via L16. SMTP creds AES-256-GCM at rest; transcript/log never see plaintext. **Deferred**: BBBG PDF attachment (CP4), per-card real status logic + HỦY workflow trigger UI + edit-after-send notifications (CP5). |
| SALES_REVENUE_TICK | `GET /api/jobs?tab=revenue_pending` + `GET /api/jobs?tab=revenue_entered` + `PATCH /api/jobs/:id/revenue-tick` + `DELETE /api/jobs/:id/revenue-tick` | `schema.sql` (`jobs.revenue_entered_at TIMESTAMPTZ NULL`, `jobs.revenue_entered_by INTEGER NULL FK users(id) ON DELETE SET NULL`, partial composite index `idx_jobs_revenue_status` on `(sales_id, completed_at, revenue_entered_at) WHERE deleted_at IS NULL`), `routes/jobs.js` (4 tab modes in `GET /` — `pending`/`completed`/`revenue_pending`/`revenue_entered` — plus 2 tick endpoints; unified Sales role guard scopes `j.sales_id = req.user.id` on every tab), `pages/SalesDashboard.jsx` Tab 3 "Quản lý công việc" with 3 sub-tabs (🔵 Job pending / 🟡 Yêu cầu nhập thu / 🟢 Đã nhập thu), `SalesCard` mobile card frame (Phase B3 style), header stat card #7 "💰 Yêu cầu nhập thu" with 30s polling + amber→red urgency cue at count >5. **M1**: schema. **M2**: backend endpoints + Sales filter promotion + closes prior `tab=completed` cross-sales exposure gap. **M3**: frontend skeleton + sub-tab nav + lazy queries. **M4**: 12/9/9 column sets + tick/un-tick action buttons + 3 mobile card variants + `revenue_entered_by_name` JOIN on `GET /api/jobs`. **M5**: header stat card #7 + this documentation. Sales ticks completed LOG jobs as "đã nhập thu" after entering revenue into external accounting software — no amount stored, just a timestamp + acting user. Un-tick allowed anytime (no time limit). See L22 + Note below. |

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

9. **Always `railway up --detach` after every push.** Railway GitHub auto-deploy is **not active** for this service (Settings → Source shows "Auto deploy unavailable"). A commit that ships to GitHub but never gets `railway up` is invisible to production. Full checklist in §7. Rationale + verification protocol in **L18**.

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
- `GET /api/jobs/` → `tk_notes`, `truck_delivery_location`, `cus_name`, `ops_name`, `tk_status`, `tq_datetime`, `truck_completed_at`, `import_export`
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

### L16 — JSON-array text columns for small repeated values

**Root cause pattern:** When a parent row needs an unbounded list of small values (CC emails, tags, alternate phone numbers, etc.), a child table is overkill — the lifecycle is identical to the parent and there's never a reason to query individual elements server-side. The natural shape is a JSON-stringified array stored in a single TEXT column.

**Concrete shape** (used by `transport_companies.email_cc`):
- Schema: `email_cc TEXT DEFAULT '[]'`. Default is the empty-array JSON literal so a parsed read is always defined.
- Wire format: array of strings on the wire (`['ops@vinasun.vn','billing@vinasun.vn']`); JSON-stringified on disk (`'["ops@vinasun.vn","billing@vinasun.vn"]'`). Backend translates at the boundary in BOTH directions.
- Read helper (`parseEmailCc`): `JSON.parse` with safe `[]` fallback on any parse error or non-array result. Single corrupt row never breaks the list endpoint or page.
- Write helper (`prepareEmailCc`): trim each element, drop empties, validate non-empty entries via the same regex as scalar email field (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`). Returns `{ok: true, value: <jsonString>}` or `{ok: false, badEmail: <first-failing>}`. Backend returns 400 with the offending email so the user sees which one is wrong.
- Frontend state: array including empty strings while editing (so user can keep typing without losing focus or hitting validation prematurely). Filter+validate only on submit.

**Rules:**
1. Choose JSON-array TEXT (not native `TEXT[]` or a separate child table) when:
   - Items are small (emails, tags, short codes — not multi-field records)
   - Lifecycle matches parent (deleted with parent, no independent timestamps)
   - You never need to query for parent rows where "any element matches X" — if you do, use a child table or `TEXT[]` + GIN index.
2. Always JSON.parse with try/catch and a safe fallback. Don't trust the disk.
3. Validate every element on write — never write an array containing values that wouldn't pass the scalar field's check.
4. The empty-array default `'[]'` (not `''`, not `NULL`) keeps the parse helper trivial.

Currently: `transport_companies.email_cc`. Future candidates: alternate phone numbers, supplier-provided tracking numbers per shipment, OPS-task tags, etc.

### L17 — Soft delete on a table with composite unique index needs a partial index AND matching ON CONFLICT predicate

**Root cause pattern:** Adding `deleted_at TIMESTAMPTZ` to a table that already has a UNIQUE INDEX on `(col_a, col_b)` looks like a one-line schema change, but it silently breaks two paths:

1. **The unique index still enforces uniqueness against soft-deleted rows.** A user soft-deletes `(A, "ABC")`. Later, a legitimate re-create of `(A, "ABC")` fails or — worse — UPDATEs the tombstoned row via `ON CONFLICT DO UPDATE`, leaving the "fresh" entity hidden behind `deleted_at`.
2. **Existing `ON CONFLICT` clauses key off the non-partial index.** If you replace it with a partial index `WHERE deleted_at IS NULL`, every `ON CONFLICT (col_a, col_b)` clause in the codebase that touched that table must be rewritten to `ON CONFLICT (col_a, col_b) WHERE deleted_at IS NULL`, otherwise Postgres errors out with "there is no unique or exclusion constraint matching the ON CONFLICT specification" or — depending on transient state — picks an unintended index.

**Pattern (used by `transport_companies` and `customer_pipeline`):**
- `ALTER TABLE x ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;`
- `DROP INDEX IF EXISTS idx_x_unique_cols;`
- `CREATE UNIQUE INDEX IF NOT EXISTS idx_x_unique_cols_active ON x(col_a, col_b) WHERE deleted_at IS NULL;`
- Add a partial index on `deleted_at IS NOT NULL` if soft-deleted rows are scanned regularly.
- Update every UPSERT against the table to use `ON CONFLICT (col_a, col_b) WHERE deleted_at IS NULL DO UPDATE ...`.
- Update every read query that should hide soft-deleted rows to add `AND deleted_at IS NULL`. Grep the codebase for the table name; don't trust a mental audit.

**Rules:**
1. Whenever soft-delete is added to a table, immediately audit every `customer_pipeline`/`<table_name>` reference in `backend/src/routes/**/*.js`. Each read needs `deleted_at IS NULL` unless the path intentionally serves deleted rows (e.g. tombstone resolver).
2. Drop and re-create the unique index as a partial one in the same migration. Don't leave both — the old index alone will permit silent tombstone updates.
3. Update every `ON CONFLICT` clause that references the rewritten index, with the matching `WHERE deleted_at IS NULL` predicate.
4. The opposite pattern — hard delete with CASCADE — is also valid for tables where retention isn't needed. Choose deliberately; soft-delete adds long-term filter discipline.

Applies to: `customer_pipeline.deleted_at` (added 2026-05-11), `transport_companies.deleted_at`. Future candidates: `jobs.deleted_at` (already exists; consider auditing its readers next).

### L18 — Always deploy after push (Railway auto-deploy is unavailable)

**Root cause pattern:** This project's Railway service has GitHub auto-deploy disabled (Settings → Source shows "Auto deploy unavailable"). `git push origin master` ships code to GitHub but does **not** trigger a Railway build. Without an explicit `railway up --detach`, the production container keeps serving the previous bundle indefinitely. Confirmed 2026-05-11: four commits sat on `master` for hours before anyone noticed production was 2 days stale.

**The exact post-commit workflow — every commit, every time, no skipping:**

```bash
# 1. Stage relevant files only (never `git add -A` — see §5 rule 8 implicitly)
git add <changed files>

# 2. Commit with a descriptive message
git commit -m "<descriptive message>"

# 3. Push to GitHub
git push origin master

# 4. **MUST DO — DO NOT SKIP.** Trigger the Railway build + container swap.
railway up --detach

# 5. Verify deployment by probing a new endpoint behavior or new bundle hash
#    e.g. for a new route /api/foo:
#      curl -s -o /dev/null -w "%{http_code}\n" https://fwd-sales-production.up.railway.app/api/foo
#    Expected: 401 (route exists, auth required), NOT 200 + text/html (SPA fallback = route missing).
#    For frontend-only changes: re-fetch / and confirm assets/index-<hash>.js changed.

# 6. Report deployment status to the user (built bundle hash, image timestamp,
#    or specific feature verification — not just "should be live now").
```

**Rules:**
1. Treat steps 1-6 as ONE atomic unit. Stopping after step 3 is a half-shipped change — the GitHub `master` truth and the production truth diverge, and "I pushed it" becomes a misleading status report.
2. `railway up --detach` returns as soon as the upload finishes (~5-15s). The actual build + swap takes 2-4 min. Use the build URL it prints, or `railway logs --build`, to confirm progress.
3. Verification is mandatory because uploads can succeed while builds fail (e.g. broken `package.json`, missing env var, schema migration error). A green CLI exit code is not proof the new container is live.
4. When reporting "how to test" instructions to the user after a feature commit, DO NOT phrase them as "After Railway redeploys, ..." — that implies auto-deploy. Phrase them as "After `railway up --detach`, ..." OR perform the deploy yourself and report the actual verified state.
5. If multiple commits are batched, one `railway up --detach` at the end ships all of them — no need to deploy per commit. But never push without a deploy.

**When to deviate (rare):**
- Doc-only changes (`.md` files, `.github/`, anything not affecting `frontend/` or `backend/`) still need `railway up` to keep the build cache hash in sync with `master`, but they don't change runtime behavior. Skipping deploy for a pure doc commit is acceptable IF the next code commit's deploy is guaranteed within minutes.
- A WIP/throwaway branch push that isn't `master` doesn't trigger anything (Railway watches `master`-equivalent only via manual `railway up`, which uploads the current working directory regardless of branch). Stay on `master` for actual ships.

**How to fix the root cause** (preferred long-term):
1. Railway dashboard → fwd-sales service → Settings → Source.
2. Connect the GitHub repo if not connected; choose `master` as the deploy branch.
3. If "Auto deploy unavailable" persists, check the Railway plan / GitHub App permissions — the integration may have been revoked.
4. Once auto-deploy is restored, this lesson becomes "Always verify deploy after push" (steps 5-6 remain mandatory; step 4 becomes the GitHub webhook).

### L19 — One column, two semantic meanings tied to a sibling column's value

**Root cause pattern:** Sometimes one DB column must carry two semantically different values depending on a sibling column's value. `jobs.han_lenh` (TIMESTAMPTZ) is the canonical example: when `import_export = 'import'` it means *"Hạn lệnh"* (a calendar date only — no useful time-of-day), when `import_export = 'export'` it means *"Cutoff time"* (a precise datetime — carrier deadline). The temptation is to add a second column (`cutoff_time`) but that fragments the same lifecycle event across two nullable fields, and every query that filters on "the job's deadline" has to UNION or COALESCE them.

**Pattern:** keep one column, branch the UI + validation by the sibling column.

- **Storage:** one column, single TIMESTAMPTZ. For date-only semantics, store as midnight in the project timezone (Postgres parses `'YYYY-MM-DD'` literal as midnight in the session TZ on INSERT into TIMESTAMPTZ).
- **Frontend input type:** branch by sibling. For `han_lenh` it's `<input type="date">` vs `<input type="datetime-local">`. Wrap any sibling-toggle handler so the value survives the switch — when going datetime→date, slice off `T...` (lossy on purpose, per spec); when going date→datetime, append `T00:00` so the datetime-local input has a valid value.
- **Frontend display:** branch the *label* AND the *format* by sibling. For `han_lenh`: `'Hạn lệnh' / fmtDate` vs `'Cutoff time' / fmtDt`. Column headers stay generic ("Hạn lệnh / Cutoff") so a single column position works for mixed rows.
- **Validation:** branch the error message by sibling, but the underlying truthy check is the same (`!value`). Don't write two separate validation branches that drift out of sync.
- **Backend SQL "missing_fields" strings:** if the backend builds user-visible label strings server-side (e.g. `CASE WHEN col IS NULL THEN 'X ' ELSE '' END`), the branching must reach down into the SQL. Use a nested `CASE WHEN sibling_col = 'X' THEN 'LabelA' ELSE 'LabelB' END` rather than always emitting one label.

**Concrete touch points** (for `jobs.han_lenh` + `jobs.import_export`):
- `CreateJobModal.jsx`: conditional input type (date / datetime-local), conditional label, `setImportExport()` wrapper rewrites `han_lenh` value across the switch, submit validation branches the error message.
- `JobDetailModal.jsx`: conditional readonly Row label + format, conditional edit input type (with date-input value sliced to `YYYY-MM-DD`).
- `LogDashboardTP.jsx` + `JobListModal.jsx`: column header "Hạn lệnh / Cutoff" (generic), cell renderer branches `fmtDate` vs `fmtDt`. Falsy/NULL renders as `'—'` either way.
- `LogDashboardCus.jsx` `getMissingFields`: missing-info chip label branches by sibling.
- `routes/jobs.js` POST validation: same truthy check, branched error message.
- `routes/jobs.js` SQL drilldown queries: nested `CASE WHEN j.import_export = 'import' THEN 'Hạn lệnh' ELSE 'Cutoff time' END`.

**Rules:**
1. When adding a column that has two semantic meanings by sibling, write a one-line note in CLAUDE.md naming the column + sibling + the two meanings. Future readers won't infer the contract from grep alone.
2. Don't split the column into two unless the lifecycle actually diverges (one created earlier, deleted independently, joined separately). Sibling-driven semantic split is fine for fields that share lifecycle.
3. Audit ALL display + validation surfaces in the same commit (per L9). Missing one site means the user sees "Hạn lệnh: 14/05/2026" labeled as "Cutoff time" elsewhere — confusing and the kind of bug that hides until QA.
4. If a write path doesn't enforce the sibling-aware required-field rule (e.g. PUT /:id allows any value), document that asymmetry explicitly. Don't let "required on create, optional on edit" be implicit.

Applies to: `jobs.han_lenh` (current). Future candidates: any field with semantically distinct date-only vs datetime-with-time usage (e.g. delivery scheduling for FCL vs LCL, customs deadlines for import vs export trade lanes).

### L20 — M:N booking-container pattern + derived status function

**Root cause pattern:** Multi-truck booking semantics don't fit the original `job_truck` shape (1:1 with jobs, single `transport_name`/`vehicle_number` per job). A single job can be split across several carriers, each carrier hauling a subset of the containers on its own schedule, and a single container belongs to at most one carrier at a time. Trying to bend `job_truck` (or any 1:1 table) to express this leads to either duplicate `job_truck` rows per job (FK-unsafe), nullable columns that carry split-by-position semantics (fragile), or a JSON blob (unqueryable).

**Pattern (Phase 1 schema):**
- `truck_bookings` is the parent — one row per "chốt kế hoạch giao xe với 1 vận tải". Carries the booking-level fields (carrier, planned datetime, delivery location, cost, vehicle, notes, lifecycle timestamps including `deleted_at`).
- `truck_booking_containers` is the M:N link — `(booking_id, container_id)` with `UNIQUE(container_id)`. The UNIQUE on the child column is the key invariant: it makes "one container belongs to one active booking" a DB constraint, not application logic. Re-assigning a container = delete the link row, re-insert under a different booking. Container splits across bookings are simply multiple link rows pointing back at the same `job_id` from different bookings.
- `job_truck` is left in place but **deprecated**. Treat it as legacy; new code uses `truck_bookings` exclusively. Removing `job_truck` is a later phase, after all `routes/jobs.js` consumers migrate.

**Derived status function** (`get_truck_booking_status(p_job_id INT) RETURNS TEXT`):
- Returns one of 5 states by joining container counts vs booking counts vs vehicle assignments. Logic lives in plpgsql so dashboards can call it via a single SELECT and get consistent semantics across endpoints. Embedding the logic in JS in each consumer would let the four roles' dashboards drift apart silently.
- States:
  - `no_containers` — job has zero `job_containers` rows. Display as "—" or "Chưa có cont".
  - `chua_dat_xe` — has containers, zero active bookings. **Action needed: DD must book.**
  - `dat_xe_1_phan` — at least one container booked, but some still loose. Job is mid-progress; DD needs to book the remainder.
  - `da_dat_xe_du_cho_so_xe` — all containers booked, but some bookings missing `vehicle_number`. Booking is committed; waiting on carrier to assign trucks.
  - `da_giao_xong` — all containers booked AND every booking has a `vehicle_number`. Operationally done from a booking perspective; CUS/OPS still drive final completion via existing TK/OPS workflow.
- Soft delete filters apply throughout (`tb.deleted_at IS NULL`). The partial unique index `WHERE deleted_at IS NULL` on supporting indexes makes "one container per active booking" survive re-booking after soft-delete (L17 pattern).

**Rules:**
1. Whenever a job-level decision (who hauls, when, where, cost) can split across multiple carriers, use this `parent + M:N link` shape. Don't pile multi-carrier semantics onto a 1:1 table.
2. The UNIQUE on the link's child column is the load-bearing invariant. Without it, application code becomes responsible for preventing double-booking — which is exactly the kind of distributed-state bug that surfaces at 2am.
3. Derived states that combine multiple table counts belong in a plpgsql function called from SQL, not in JS. This keeps the four dashboards aligned on a single source of truth and makes the rule auditable in a single place.
4. When introducing a replacement for an existing table, **deprecate, don't drop**. Leave the legacy table in `schema.sql` until every reader has migrated. Migration order is: ship the new schema → migrate routes one at a time → drop the legacy table only when grep returns zero hits.

Applies to: `truck_bookings` + `truck_booking_containers` (current). Future candidates: any other 1:1-jobs-to-X relationship that grows multi-X semantics (e.g. multi-tờ-khai per job, multi-OPS-vendor per job).

### L21 — Mobile-first responsive UI (Phase 1 baseline)

**Every new UI feature MUST be responsive from day 1.** Apply the project's standard breakpoint scheme:

| Tier | Range |
|------|-------|
| Desktop | ≥ 1024px |
| Tablet  | 768–1023px |
| Mobile  | < 768px |

**Shared utilities live in `frontend/src/index.css`** — use them; do not redefine:
- `.stat-grid` — dashboard stat-card grids (auto-fit minmax(180px, 1fr) on desktop, 1 col on mobile)
- `.form-grid-2 / -3 / -4 / -5` — inner form grids in modals (N cols on desktop, 1 col on mobile)
- `.navbar-desktop-items` / `.navbar-mobile-right` / `.navbar-hamburger` / `.navbar-mobile-menu` — hamburger swap at ≤768px (used only by `components/Navbar.jsx`)

**Rules:**

1. **New pages:** design mobile-first (375px), then enhance for desktop. Don't ship a desktop-only layout and "make it responsive later" — by L9 the audit catches the gap and forces a rewrite.
2. **New modals:** use Pattern A — `<div className="modal-overlay"><div className="modal modal-lg">…`. Never inline `position: fixed; inset: 0; ...` — Pattern B bypasses the `@media (max-width: 768px)` bottom-sheet rule and loses mobile UX.
3. **New stat grids:** use `.stat-grid` (not inline `gridTemplateColumns: repeat(N, 1fr)`).
4. **New form grids inside modals:** use `.form-grid-N`. If you need a non-N proportional layout (e.g. `'90px 1fr 1fr'` for a label + 2 inputs), keep it inline but verify mobile readability — the `90px` chip + 2 narrow inputs is the only currently-accepted exception (`CreateJobModal.jsx:539`).
5. **Touch targets:** keep tappable elements ≥ 36×36 px. The shared `.btn` class is fine; bare icon-only buttons need `padding: 8px` minimum.
6. **Inputs in mobile contexts:** `width: 100%; max-width: <desktop-cap>; min-width: 0; box-sizing: border-box`. Never hard-pin `width: <px>` on inputs that may sit inside the mobile-menu dropdown.
7. **Pop-out dropdowns** positioned via `getBoundingClientRect()` (e.g. GlobalSearch, NotificationBell): always cap with `maxWidth: 'min(<desktop-max>px, calc(100vw - 32px))'` so they never overflow the viewport.

**What Phase 1 (2026-05-12) shipped — for context when reading older code:**
- Navbar hamburger collapse at ≤768px (`components/Navbar.jsx`)
- `.stat-grid` swap on all 5 dashboards
- 4 modal converts: CustomerDetailModal, AddCustomerModal (success + main), CustomerJobsModal — Pattern B → Pattern A
- `.form-grid-N` swaps in `CreateJobModal` (5/3/3), `BookingModal` (2), `BBBGModal` (5 grids)

**Deferred to Phase 2 / 3** (do not retrofit unless explicitly scoped):
- `JobDetailModal` split-pane (left info / right tabs) — load-bearing edit UX, stacks need a tab redesign
- Big data tables (TP/Cus/Ops/DieuDo main grids) — keep horizontal scroll; introduce Card view per table on Phase 2
- `CreateJobModal:539` 3-col cont detail row — accepted tight layout on mobile
- `QuoteForm` 4-col PA option rows
- Touch-friendly replacement for `title="..."` tooltips on `CustomerDataPage`

### L22 — Tab modes on a polymorphic GET endpoint demand role-scoping consistency across ALL modes

**Root cause pattern:** When `GET /api/jobs` was built, it had two tabs (`pending` / `completed`). The `pending` branch role-scoped every consumer (`role==='sales'` → filter `j.sales_id`; LOG roles → filter by assignment). The `completed` branch deliberately skipped role-scoping with the comment *"Feature 1: no role filtering for completed tab — all LOG roles see all completed jobs"*. That comment was correct for the LOG team — TP/CUS/OPS/DD should all see every completed job — but it silently violated Sales role-scoping: a `role='sales'` user hitting `tab=completed` saw every sales' jobs, not just their own. This sat as a latent data-exposure bug until M2 introduced two NEW tab modes (`revenue_pending` / `revenue_entered`) and forced an audit.

**Pattern:** When adding a new tab mode to a polymorphic GET endpoint, audit ALL existing tab branches for role-scoping consistency BEFORE adding the new branch. If any role's filter is conditional on which tab is active, ask whether that conditional is intentional (different audiences per tab) or accidental (the original author only thought about one tab). Sales filtering is almost always wanted-on-every-tab; LOG role filtering is sometimes per-tab (e.g., TP sees all on completed but CUS sees only their own on pending).

**Concrete shape** (used by `routes/jobs.js` `GET /` after M2):
1. Hoist role-based scoping ABOVE the per-tab `if/else if` chain when it applies to every tab. Pattern:
   ```js
   conditions.push('j.deleted_at IS NULL');
   if (role === 'sales') {
     conditions.push(`j.sales_id = $${idx++}`);  // ALWAYS scope sales
     params.push(userId);
   }
   if (isCompleted) { /* date filter, no further role filter */ }
   else if (isRevenuePending) { /* etc */ }
   ...
   else { /* pending — LOG-role assignment filter goes here, sales already handled */ }
   ```
2. The unified guard fires on every tab; per-tab branches only add tab-specific predicates (date range, status, revenue_entered_at IS NULL, etc.). LOG roles still see all completed jobs by *intentional omission* — but the absence is now visible at the top of the handler, not hidden inside an `else` branch.
3. Tab-aware `ORDER BY` lives next to the per-tab predicates (`isRevenuePending` → `j.completed_at ASC` for FIFO; `isRevenueEntered` → `j.revenue_entered_at DESC` for newest tick first).

**Rules:**
1. When adding a new tab mode, audit ALL existing tab branches for the role you're targeting. Don't assume previous authors closed every role-scope hole.
2. If a role's filter applies to every tab (Sales scoping is the canonical example), hoist it ABOVE the tab branching. This makes the intent visible to future readers and eliminates the risk of the next tab-mode addition forgetting to re-apply it.
3. If a role's filter intentionally applies to *only some* tabs (LOG team sees-all on completed by design), document why in a code comment AT the omission site so a future audit doesn't accidentally "fix" it.
4. The same pattern applies to drilldown endpoints, search endpoints, and any other polymorphic SELECT that branches on a query param.

Applies to: `routes/jobs.js GET /` (current). Future candidates: any new tab-mode addition on any polymorphic endpoint (`/api/reports`, `/api/customers`, `/api/quotes` if they grow tab modes).

### Note — `jobs.import_export` (Loại lô)

Two-value enum on `jobs`: `'export'` (Hàng xuất, default) or `'import'` (Hàng nhập). Selected at create time in `CreateJobModal` — pill segment in the TOP-ROW grid alongside Mã Job / Mã SI / Loại dịch vụ / Điểm đến (the earlier placement below the FCL/LCL toggle was easy to miss; do not move it back). CHECK constraint enforces values; column is `NOT NULL DEFAULT 'export'` so legacy rows auto-fill on `ADD COLUMN`. **Editable post-create** (reversed 2026-05-20 — was previously locked) — `PUT /api/jobs/:id` accepts `import_export` in `FIELDS` with the same `['export','import']` validation as POST; `JobDetailModal` edit mode exposes the same Hàng xuất / Hàng nhập radio selector as `CreateJobModal`, and the `han_lenh` input swaps between `<input type="date">` (import) and datetime-local (export) live as the user toggles. The frontend tiny badge (Xuất green / Nhập amber) in all 4 LOG dashboards' job lists, and the readonly Row in `JobDetailModal` "Thông tin chung" section, both still read `job.import_export` (server source of truth — never `draft.import_export`).

### Note — FCL container quantity matrix (CreateJobModal)

The old "+ Thêm cont / ✕ Xóa cont" UX in `CreateJobModal` was replaced with a 6-cell **quantity matrix** (one number input per `CONT_TYPES` entry — 20DC, 40DC, 40HC, 45HC, 20RF, 40RF) plus an auto-generated **detail list**. The matrix is the source of truth for row count and type; detail rows expose only `cont_number` + `seal_number` (the `cont_type` chip is read-only and follows the matrix).

**Reconcile rules** (`setQty(type, raw)`):
- Increase: append empty rows of that type at the end of the type's group.
- Decrease: drop rows from the end of the type's group; if any dropped row has data (`cont_number` or `seal_number` non-blank), `window.confirm("Cont X sẽ bị xóa, tiếp tục?")` first.
- Detail rows are always ordered by `CONT_TYPES` enumeration order, so visual grouping is stable.
- Switching cargo type FCL→LCL→FCL via `selectCargoType()` resets both `contQty` and `containers` to empty (matrix all zeros, no detail rows).

**Validation on submit** (`CreateJobModal`):
- `Hàng nhập`: every detail row MUST have both `cont_number` AND `seal_number` non-blank. Error: `"Hàng nhập phải nhập đủ số cont và seal cho tất cả container"`.
- `Hàng xuất`: row-level fields optional (numbers arrive later from carrier).
- Zero rows is permitted at submit time (user may still be drafting; backend simply inserts zero `job_containers` rows).

**Backend contract unchanged.** POST `/api/jobs` still reads `containers` as `Array<{cont_type, cont_number, seal_number}>` and the row-by-row INSERT in `routes/jobs.js:1006-1013` still skips rows with empty `cont_type`. The wire format is preserved; only the in-modal authoring UX changed.

**Out of scope (not touched in this commit):** `JobDetailModal` edit UI still uses the old per-row `cont_type` dropdown + manual add/remove. If we adopt the matrix UX there too, copy the `contQty` + `setQty` pattern verbatim and reset matrix from `job.containers` group-by-type counts in `buildDraft`.

### Note — Sales "Quản lý công việc" tab (revenue-tick handoff)

3rd tab on `/my-dashboard` (after "📋 Báo cáo của tôi" + "📊 Danh sách hoạt động"). Tracks LOG-completed jobs through the revenue-recognition lifecycle so Sales has a visible queue of "jobs the LOG team finished — I owe Accounting a debit note for these." Crucially, **the revenue amount is NOT entered in this app** — it's entered in external accounting software. The in-app tick is just a flag (`revenue_entered_at` timestamp + `revenue_entered_by` user id) so Accounting can pull the queue without chasing Sales.

**Schema** (added M1):
- `jobs.revenue_entered_at TIMESTAMPTZ NULL` — timestamp when Sales ticked. NULL = not yet ticked.
- `jobs.revenue_entered_by INTEGER NULL REFERENCES users(id) ON DELETE SET NULL` — acting sales user.
- `idx_jobs_revenue_status` — partial composite index on `(sales_id, completed_at, revenue_entered_at) WHERE deleted_at IS NULL`. Serves all 3 sub-tab queries plus the always-on header count query.

**Sub-tab queries** (all SCOPE BY `j.sales_id = current_user.id`; see L22):

| Sub-tab | Backend `tab` | WHERE | ORDER BY | Polling |
|---|---|---|---|---|
| 🔵 Job pending | `pending` | `status='pending' AND sales_id=$user` | `j.created_at DESC` | 5s visible / 30s hidden |
| 🟡 Yêu cầu nhập thu | `revenue_pending` | `status='completed' AND revenue_entered_at IS NULL` | `j.completed_at ASC` (FIFO) | 5s visible / 30s hidden |
| 🟢 Đã nhập thu | `revenue_entered` | `revenue_entered_at IS NOT NULL` + date filter on `j.completed_at` (default last 7d) | `j.revenue_entered_at DESC` | none (date-bound) |

**Mutating endpoints**:
- `PATCH /api/jobs/:id/revenue-tick` (sales-only, own job, completed, not yet ticked). UPDATE sets `revenue_entered_at = NOW(), revenue_entered_by = $user`. Audit row via `recordHistory('revenue_entered_at', null, NOW)`.
- `DELETE /api/jobs/:id/revenue-tick` (sales-only, own job, currently ticked). **No time limit** on un-tick — the column flips back to NULL whenever Sales notices an error. Audit row via `recordHistory('revenue_entered_at', prevTs, null)`.

Both endpoints return the bare `jobs.*` row (RETURNING `*`). Frontend invalidates `queryKey: ['jobs']` on success so all 3 sub-tab counts + header card refetch atomically.

**Header stat card #7** (added M5): `<StatCard label="Yêu cầu nhập thu" icon="💰" />` reads from a separate `useQuery({ queryKey: ['jobs','revenue_pending','count_only'], refetchInterval: 30000, enabled: user?.role === 'sales' })`. Color urgency cue: muted at 0, amber at 1-5, danger red at >5. Click → `setActiveTab('job_management') + setSubTab('revenue_pending')` so Sales jumps directly to the queue. The `'count_only'` discriminator keeps this query separate from the in-tab Sub-tab 2 query (different polling cadences).

**Mobile**: `SalesCard` helper (mirror of `TPCard`/`CusCard`/`OpsCard` from Phase B1-B3) + 3 `renderMobileCard` variants per sub-tab — Phase B3-style card list at ≤768px with the same tick/un-tick actions as desktop.

**Rules to honour going forward**:
1. The revenue-tick lifecycle is Sales-only by design. Don't add LOG-role write paths; if Accounting needs visibility, expose a read-only endpoint scoped to `lead` (Trưởng Phòng Sales) or a future ACCOUNTING role.
2. Don't store revenue amounts in the app — the spec is deliberately minimal. If an amount is ever required, it belongs in a new `job_revenue` child table, not on the `jobs` row.
3. The un-tick path has NO time limit on purpose. Don't add a 24h or 7d cap; Sales need to correct errors whenever they're spotted, and Accounting reverses debit notes the same way.
4. Audit trail for ticks lives in `job_history` rows under `field_name = 'revenue_entered_at'`. Don't create a parallel `revenue_history` table.
5. When the team needs an aggregated view across all sales (e.g. "how many jobs are awaiting revenue this quarter"), TP/lead role can hit `GET /api/jobs?tab=revenue_pending` without a `sales_id` filter — the unified Sales guard at L22 only applies to `role='sales'`, so a TP request sees everyone's queue.

### L15 — Invoice info on customer_pipeline (snapshot semantics, preserve-on-conflict)

**Root cause pattern:** Invoice data — full legal company name, tax code, invoice address — needs to live somewhere queryable per customer. Storing it on `jobs` would require duplicating across every job for the same customer. Storing it on `customers` interaction rows would scatter it across N rows. The natural home is `customer_pipeline` (one row per `(sales_id, lowered company_name)` per L14).

> Earlier revision included a `short_name` column but it was dropped — `customer_pipeline.company_name` already serves as the internal short/display name. Don't add it back without a clear new use case.

**Schema** (idempotent ALTER):
- `customer_pipeline.company_full_name VARCHAR(300) DEFAULT ''` — official Vietnamese legal name (e.g. `'CÔNG TY CỔ PHẦN ABC VIỆT NAM'`)
- `customer_pipeline.invoice_address TEXT DEFAULT ''` — full address as it must appear on the printed invoice
- `customer_pipeline.tax_code VARCHAR(30) DEFAULT ''` — MST. Note: `customers.tax_code` already exists for the sales-CRM side and `jobs.customer_tax_code` exists separately — these are 3 distinct columns despite similar names.

**Form behavior** (`CreateJobModal.jsx`):
- 3 inputs appear only in "Khách mới" mode (creating a new customer). All required.
- Submit guard: if any of the 3 is empty in `searchMode === 'new'`, show inline error `"Vui lòng nhập đủ thông tin xuất hóa đơn"` and abort.
- When user picks an EXISTING customer (search mode), the 3 fields auto-fill from `customer-search` response — this lets the user verify the saved values without retyping.

**Backend behavior** (`POST /api/jobs`):
- Destructure adds `company_full_name`, `invoice_address`, `invoice_tax_code` (the last is the JS variable name to avoid collision with the existing `customer_tax_code` on the `jobs` table — DB column is plain `tax_code`).
- INSERT writes all 3 columns alongside `(sales_id, company_name, customer_id, stage)`.
- `ON CONFLICT (sales_id, LOWER(company_name)) DO UPDATE SET stage='booked', updated_at=NOW()` — the 3 new columns are NOT in the SET clause, so existing values are preserved per spec.

**Customer-search response** (`GET /api/jobs/customer-search`): SELECT now includes `cp.company_full_name`, `cp.invoice_address`, `cp.tax_code AS pipeline_tax_code`. Frontend's `selectCustomer(c)` reads these to pre-fill.

**BBBG flow consumption** (`GET /api/jobs/:id/bbbg-data` + `POST /:id/bbbg-pdf` + `BBBGModal.jsx`):
- bbbg-data SELECT does a `LEFT JOIN LATERAL` against `customer_pipeline` keyed by `LOWER(company_name) = LOWER(j.customer_name)` (picks the row with highest id), exposes `invoice_company_name`, `invoice_tax_code`, `invoice_address` in the response.
- Modal pre-fills 3 inputs from those fields. ĐĐ can override per-PDF.
- Modal includes a checkbox `save_as_default` (default unchecked). When ticked, POST `/bbbg-pdf` body carries `save_as_default: true`, and the backend runs `UPDATE customer_pipeline SET company_full_name=$1, tax_code=$2, invoice_address=$3, updated_at=NOW() WHERE LOWER(company_name) = LOWER($4)` against ALL pipeline rows matching the customer (a customer can be in multiple pipelines per L14). Save runs BEFORE the PDF stream starts and is wrapped in try/catch — failures log a warning but do not block PDF generation.
- The PDF service inserts a "Thông tin xuất hóa đơn / (Invoice information)" section between the container table and the delivery confirmation block. Section is **omitted entirely** when all 3 fields are empty after `.trim()` — no blank rows print.

**Rules:**
1. The 3 invoice fields live on `customer_pipeline` only. Don't duplicate them onto `jobs` or `customers`.
2. ON CONFLICT branch must NOT touch invoice fields — preserves existing data per the spec.
3. Wire-format aliases: JS variable `invoice_tax_code` ↔ DB column `customer_pipeline.tax_code` ↔ response field `pipeline_tax_code` on `/customer-search`. Don't conflate with `jobs.customer_tax_code` or `customers.tax_code`.
4. When a transfer happens (per L14), the new pipeline INSERT writes whatever the form supplied. If the user selected the customer from search, the form was pre-filled — those values survive the transfer.

### L14 — Customer pipeline ownership transfers on job creation

**Root cause pattern:** Customers in this system don't belong to "the company" — they belong to a specific `sales_id` via `customer_pipeline.sales_id`. When TP/lead/DD creates a job for an existing customer but selects a different sales user, ownership must transfer cleanly. Doing nothing leaves the old sales' pipeline intact and creates a duplicate row for the new sales — splitting the customer across two pipelines and confusing every downstream stat.

**Behavior** (implemented in `routes/jobs.js` POST `/api/jobs` after the job INSERT):

1. If `sales_id && customer_name` are both present in the create-job request, find any pipelines owned by other sales for the same customer (matched by `LOWER(company_name)` OR `customer_id` FK).
2. For each: `DELETE FROM customers WHERE pipeline_id = X` (manual — `customers.pipeline_id` is `ON DELETE SET NULL`, not CASCADE; we want hard delete here so old sales loses interaction history too), then `DELETE FROM customer_pipeline WHERE id = X`. Cascades clear `pipeline_history` and `pipeline_delete_requests` automatically.
3. UPSERT pipeline for the chosen sales: `INSERT ... ON CONFLICT (sales_id, LOWER(company_name)) DO UPDATE SET stage='booked'`. Use `RETURNING id, (xmax = 0) AS was_inserted` — the `xmax = 0` PostgreSQL trick distinguishes a newly-inserted row from an updated one.
4. Notifications:
   - Old sales (each one if multiple): `type='pipeline_transferred_out'` — "Khách [name] đã được chuyển khỏi pipeline của bạn bởi [actor]"
   - New sales: `type='pipeline_transferred_in'` (when transfer happened) OR `type='pipeline_added'` (when fresh insert, no transfer)
5. Audit on the JOB (not the deleted pipeline): `recordHistory(job_id, 'pipeline_transferred', oldSalesNames, newSalesName)`.

**Frontend confirmation** (`CreateJobModal.jsx`): when `selectedCustomer.sales_id !== form.sales_id`, intercept submit with a confirm dialog showing both names and the destructive nature. The sales dropdown is editable (the previous `disabled={locked}` was removed) so any user — TP, CUS, DD — can trigger transfer per spec.

**Rules:**
1. Whenever you read or write `customer_pipeline.sales_id`, remember that the sales user is the *owner*, not the company. Don't query "all pipelines for company X" without filtering by `sales_id`.
2. The `(sales_id, LOWER(company_name))` UNIQUE INDEX is the canonical key. The pre-transfer DELETE uses name-match OR FK-match because the indexed key is `sales_id + name` only.
3. The `xmax = 0` clause on `RETURNING` after `ON CONFLICT` is the standard way to detect insert-vs-update without a second query.
4. Manual `DELETE FROM customers WHERE pipeline_id = X` is required because the FK is `SET NULL` (intentional for unrelated paths). Don't change the FK to CASCADE — that affects user-deletion cleanup too.

Applies to any future feature that re-assigns a customer between sales users.

### L13 — Snapshot pattern for FKs to user-managed reference tables

**Root cause pattern:** When introducing a reference table (e.g. `transport_companies`) and pointing existing rows at it via FK, two real-world problems hit immediately:

1. **Renames in the reference table change history.** If `transport_companies.name` is updated and you only store `transport_company_id` on `job_truck`, every past job retroactively shows the new name — which makes printed/exported documents (like BBBG) incorrect.
2. **Hard-deletes break referential closure.** Even with `ON DELETE SET NULL`, the moment the FK clears, you have no idea what the row used to point at.

**Pattern (used by transport_companies):** keep BOTH the FK and a denormalized "snapshot" string column. On select/update, write both. On read, prefer the JOIN'd current name when the FK is non-null (so renames flow through to live UI), but fall back to the snapshot when the FK is null (so legacy rows and post-delete rows still render). This gives you:
- Renames flow through to live data ✓
- Soft-delete: row keeps showing through current FK ✓
- Hard-delete (FK SET NULL): snapshot survives ✓
- Legacy rows from before the FK was introduced ✓ (FK = NULL, snapshot = whatever they had)

Example concrete shape:
```sql
ALTER TABLE job_truck
  ADD COLUMN transport_company_id INTEGER REFERENCES transport_companies(id) ON DELETE SET NULL;
-- Existing transport_name column stays. New writes set both columns from the picker.
SELECT j.*, tc.name AS tc_name, jtr.transport_name
FROM jobs j LEFT JOIN job_truck jtr ON ...
            LEFT JOIN transport_companies tc ON tc.id = jtr.transport_company_id;
-- Frontend renders: tc_name ?? transport_name
```

**Rules:**
1. When adding a FK to a user-managed reference table that names things (companies, ports, products, etc.), keep a `*_name` snapshot column too. Write both.
2. Prefer `ON DELETE SET NULL` over CASCADE for these FKs. The snapshot column is the historical record.
3. Add a `LOWER(name)` UNIQUE INDEX on the reference table — VARCHAR UNIQUE alone is case-sensitive and `"Vinasun"` vs `"VINASUN"` will both insert.
4. The snapshot column can be marked "legacy" in the UI when FK is NULL (small visual hint to encourage re-picking from the dropdown).

Applies to future tables: `ports`, `vendors`, `forwarders`, `customs_brokers`, etc.

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

### L23 — MCP server (Windows) — wrap an npm `.cmd` in `cmd.exe /c`

**Root cause pattern:** An MCP server in `C:\Users\HP\.claude.json` that launches an npm-installed CLI (e.g. `codegraph`) fails to start on Windows. The failure has **two layers** and surfaces as two different errors in sequence:

1. **`spawn <tool> ENOENT`** — the config used a bare command name (`"command": "codegraph"`). On Windows that resolves to the extension-less Unix shell script npm drops next to the `.cmd`, which cannot be spawned as a process → `ENOENT`.
2. **`spawn EINVAL`** — after "fixing" the command to point directly at `...\codegraph.cmd`, Node's `spawn()` **without `shell: true`** refuses to launch a `.cmd`/`.bat` file (a Node security change, CVE-2024-27980) → `EINVAL`. Claude Code's own MCP spawner tolerates a `.cmd`, but the ECC `mcp-health-check.js` PreToolUse hook does a plain `spawn(command, args)` with no `shell`, so it keeps blocking every one of that server's tools (`codegraph_*`) with a "server is unavailable" message and a quarantine timestamp.

**Fix (standard Windows MCP pattern) — wrap in `cmd.exe`:**
```json
"codegraph": {
  "type": "stdio",
  "command": "C:\\Windows\\System32\\cmd.exe",
  "args": ["/c", "C:\\Users\\HP\\AppData\\Roaming\\npm\\<tool>.cmd", "<tool args...>"]
}
```
`cmd.exe` is a real `.exe`, so `spawn()` launches it cleanly with no `shell` flag → no `EINVAL`; `cmd /c` then runs the `.cmd` internally. This satisfies BOTH Claude Code's spawner and the ECC health-check hook.

**Process notes:**
1. Edit `C:\Users\HP\.claude.json` **directly** with **double-escaped backslashes** (`\\`). Do **not** use `claude mcp add/remove` — on Windows it strips backslashes from the path.
2. After editing, validate the file still parses as JSON (a corrupt `.claude.json` breaks all MCP servers + Claude Code config).
3. Reload with `/mcp` → select the server → **Reconnect** (lightest action; full restart only if Reconnect isn't offered). The config is re-read on reconnect.
4. The ECC health-check quarantine clears automatically on the next successful live probe after reconnect — no manual unblock needed.

**Rules:**
1. Any Windows MCP server that launches an npm-installed CLI must use the `cmd.exe /c <tool>.cmd` wrapper — never a bare command name, never a direct `.cmd` path.
2. Verify the npm tool actually has the `.cmd` variant before pointing at it: `dir <npm-prefix>\<tool>*` — npm creates three siblings (`<tool>`, `<tool>.cmd`, `<tool>.ps1`); the `.cmd` is the one to wrap.
3. When an MCP tool is blocked with `ENOENT`/`EINVAL`, the layer at fault is the hook's `spawn()` call, not the index or the tool itself — check the `command` shape first.

Applies to: `codegraph` MCP server (fixed this session). Future candidates: any npm-based MCP server added on Windows (Context7 local installs, custom MCP CLIs, etc.).

---

### L24 — `checkAndCompleteJob` is defined in TWO files — confirm the canonical one before editing completion logic

**Root cause pattern:** CodeGraph (`codegraph_search checkAndCompleteJob`) surfaced the same function name defined in **two** files with **different signatures**:

| File | Signature | Status |
|------|-----------|--------|
| `backend/src/routes/jobs.js:44` | `(client, jobId, changedBy)` | suspect — verify if stale duplicate or thin wrapper |
| `backend/src/services/job-completion.js:14` | `(client, jobId, changedBy, recordHistory)` | **canonical Phase-4 version** |

`services/job-completion.js` is the canonical version per CLAUDE.md §3 (TRUCK_BOOKINGS) — it is the one called from `PATCH /api/truck-bookings/:id` on `vehicle_number` transitions.

**Risk:** Completion-logic fixes (the `PATCH /tk` trigger-gap call, the cost gate, FCL/LCL completion) must target the **canonical** `services/job-completion.js` version. If `routes/jobs.js:44` is a stale independent copy, a fix applied to one silently diverges from the other — exactly the "fixed here, still broken there" class of bug §9 (L9) and L10 warn about.

**TODO (deferred — not yet done):**
1. Run `codegraph_callers` on both definitions to map which call sites use which.
2. Confirm whether `routes/jobs.js:44` is a **thin wrapper** re-exporting / delegating to the `services/job-completion.js` version (likely — `job-completion.js` is imported near the top of `routes/jobs.js`), or a **stale independent copy**.
3. If it is a stale independent copy, consolidate to a single canonical definition.

Deferred because it touches shared completion logic — needs `codegraph_impact` first (per §9) and careful review, not a drive-by edit.

**Rules:**
1. Before editing any job-completion code, confirm you are editing `services/job-completion.js` (canonical), not the `routes/jobs.js` definition.
2. Do not "fix" `routes/jobs.js:44` in isolation — broadcast or consolidate per L10.
3. When a symbol search returns the same name from two files, treat it as a duplication hazard and resolve which is canonical before any edit.

Applies to: `checkAndCompleteJob` (current). General rule: any function found defined more than once by `codegraph_search`.

---

## 6. Session Start Checklist

1. Read this file.
2. Read `frontend/src/CLAUDE.md` and/or `backend/CLAUDE.md` for the area you're working in.
3. `git status` and `git log --oneline -10`.
4. Read the specific file you're about to change — don't modify what you haven't read.

---

## 7. Deployment

> **Railway GitHub auto-deploy is NOT active for this service** (Settings → Source: "Auto deploy unavailable"). Every commit needs an explicit `railway up --detach`. Full rationale + verification protocol in **L18**.

**The atomic post-commit checklist — all 6 steps, no skipping:**

1. `git add <changed files>` — stage only the relevant files (never `git add -A`).
2. `git commit -m "<descriptive message>"`
3. `git push origin master`
4. `railway up --detach` ← **MUST DO, DO NOT SKIP** (without this, production stays on the old bundle).
5. **Verify deployment with curl** — probe a route or string that's unique to this commit. Examples:
   - New API route: `curl -sw "%{http_code}\n" https://fwd-sales-production.up.railway.app/api/<new-route>` → expect 401 (route exists) not 200+HTML (SPA fallback = route missing).
   - Frontend-only change: re-fetch `/`, confirm the `assets/index-<hash>.js` filename changed; optionally `grep` the new bundle for a string unique to the commit.
   - Backend logic change without a new route: drive the change end-to-end through an existing route, or check `railway logs --build` for a fresh image timestamp.
6. **Report deployment status to the user** — bundle hash, image digest/timestamp, or feature-level verification. Do NOT report "should be live now" — only report what you actually verified.

```bash
git add <changed files>
git commit -m "<descriptive message>"
git push origin master
railway up --detach   # MUST DO
curl -s -o /dev/null -w "%{http_code}\n" https://fwd-sales-production.up.railway.app/api/<probe>
```

`start.js` on the new container runs in order: `schema.sql` migrations → `backfill_pipeline.js` → `npm run build` (frontend) → Express server. Idempotent — safe to re-run on every deploy.

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

---

## 9. CodeGraph (code navigation)

Project có `.codegraph/` index (live). For code exploration ("how does X work", "where is Y", "what calls Z"), prefer CodeGraph MCP tools over grep/glob/read:
- `codegraph_search` — find code by concept
- `codegraph_callers` / `codegraph_callees` — who calls / what it calls
- `codegraph_context` — understand a snippet
- `codegraph_impact` — **what breaks if I change this**

**Bắt buộc chạy `codegraph_impact` TRƯỚC khi sửa shared code**, đặc biệt:
- `backend/src/db/schema.sql` (DDL dùng chung)
- `checkAndCompleteJob` (job-completion.js) — completion logic chạm nhiều endpoint
- `get_truck_booking_status` (plpgsql) — truck completion, FCL + LCL
- status / role / service_type / cargo_type enums + their guards
- shared modals (JobDetailModal, PlanDeliveryModal, TruckPlanningModal) + shared dashboards

Lý do: nhiều bug gần đây là loại "sửa chỗ này quên chỗ kia" — TK trigger gap (PHƯƠNG ANH), cost gate ảnh hưởng cả 'tk' + 'both', LCL phải fix ở 2 modal riêng. `codegraph_impact` bắt được các điểm ảnh hưởng trước khi sửa.
