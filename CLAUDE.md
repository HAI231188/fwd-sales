# CLAUDE.md — SLB Global Logistics Internal Management System

> **READ THIS FILE FIRST at the start of every session.**
> Then read `frontend/src/CLAUDE.md` (UI patterns) and/or `backend/CLAUDE.md` (API & DB patterns) for the area you're working in. Both sub-files open with **Rule 0 — Independent AI review (Codex): verify before reporting "done"** (confirm names exist in scope via grep, run `node --check`/`npm run build`, confirm no regressions vs L9/L10/L26, show concrete evidence — never "it should work").

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
        ├── pages/          # Login, LeadDashboard (lead), SalesDashboard (sales), ReportDetail, ChangePassword
        └── components/     # Navbar, StatCard, DateFilter, DrilldownModal, PipelineView,
                            # CustomerDetailModal (main modal: info/quotes/interaction thread),
                            # CustomerCard, QuoteForm, AddCustomerModal
```

**Deployment:** Railway — single service runs `backend/start.js` which builds the frontend, runs migrations, then serves everything from Express. No separate frontend service.

**Local dev:**
- Backend: `cd backend && npm run dev` (nodemon, port 3001)
- Frontend: `cd frontend && npm run dev` (Vite, port 5173, proxied to 3001)

---

## 3. Module List

> **`jobs.service_type` (Loại dịch vụ)** = **4** values: `tk` (CUS làm tờ khai) / `truck` (DD vận chuyển) / `both` / `ops_hp` (OPS-only HP job, added 2026-06-06). CHECK enforced via idempotent DROP/ADD pair. Full mechanics + 11-touchpoint ripple list in **L31**.
> **`jobs.import_export` (Loại lô)** = `export` (Hàng xuất, default) / `import` (Hàng nhập). `NOT NULL DEFAULT 'export'`. Editable post-create via `PUT /:id` (`FIELDS`, same `['export','import']` validation as POST); `CreateJobModal` top-row pill + `JobDetailModal` radio; `han_lenh` input swaps date↔datetime-local live by value (L19). Badge Xuất(green)/Nhập(amber) in all 4 LOG dashboards + JobDetailModal read `job.import_export` (server truth, never `draft`).

### Current modules

| Module | Routes | Key Files / notes |
|--------|--------|-------------------|
| AUTH | `/api/auth/*` | `routes/auth.js`, `middleware/auth.js` |
| REPORT | `/api/reports/*` | `routes/reports.js`, `ReportDetail.jsx` |
| CUSTOMER | `/api/customers/*` | `routes/customers.js`, `CustomerCard.jsx` |
| QUOTE | `/api/quotes/*` | `routes/quotes.js`, `QuoteForm.jsx` (calc+PDF engine: L27) |
| PIPELINE | `/api/pipeline/*` | `routes/pipeline.js`, `PipelineView.jsx`, `CustomerDetailModal.jsx` |
| DASHBOARD | `/api/stats/*` | `routes/stats.js`, `LeadDashboard.jsx`, `SalesDashboard.jsx` |
| INTERACTION | (part of pipeline) | `CustomerDetailModal.jsx` — threaded updates, follow-up completion |
| BBBG | `GET /api/jobs/:id/bbbg-data`, `POST /:id/bbbg-pdf` | `services/bbbg-pdf.js`, `BBBGModal.jsx` — generate-on-demand delivery-handover PDF (no persistence). Role: `truong_phong_log` + `dieu_do`. Optional fonts `backend/src/assets/fonts/Roboto-*.ttf`; falls back to Helvetica if absent. Reads `truck_bookings` (earliest by planned_datetime) + invoice info (L15). |
| TRANSPORT | `/api/transport-companies/*` | `routes/transport.js`, `TransportPicker.jsx`, `TransportFormModal.jsx`, `TransportCompaniesPage.jsx` (`/transport-companies`, Navbar link TP+DD) — Quản lý tên vận tải. `GET /` returns `job_count`. `job_truck` carries `transport_company_id` (FK ON DELETE SET NULL) + `transport_name` snapshot (L13). Read: all auth; write: TP+DD. Soft-delete only; case-insensitive UNIQUE `LOWER(name)`. `email_cc` = JSON-array TEXT (L16). |
| TRUCK_BOOKINGS | `/api/truck-bookings/*` + `/api/jobs/:id/{truck-booking-status,available-containers,past-delivery-locations}` | `routes/truck-bookings.js`, `services/job-completion.js`, `BookingModal.jsx`, `utils/truckBookingStatus.js`, DD dashboard "Quản lý đặt xe". Multi-truck booking: one job → N bookings → M containers via `truck_booking_containers` (`UNIQUE(container_id)` = 1 cont ↔ 1 active booking). Full pattern + `get_truck_booking_status()` states: **L20**. **Endpoints:** `GET ?job_id=N` (any auth) → list w/ `containers[]`; `POST` (DD+TP) `{job_id, transport_company_id, planned_datetime, delivery_location, cost?, container_ids[], notes?}` — snapshots `transport_name` (L13), validates carrier live + containers belong to job + no double-booking (FCL requires `container_id`; LCL forbids it — container-less whole-lot leg); `PATCH /:id` (DD+TP) re-snapshots on carrier change, `vehicle_number` NULL→value sets `completed_at=NOW()` (reverse clears); `DELETE /:id` (DD+TP) **Option-B** = soft-delete booking + HARD-delete link rows (containers freed). DD completion split: **L25**. `job_truck` deprecated (no longer written by app code; drop deferred). |
| CUSTOMER_PIPELINE | `/api/customer-pipeline/*` | `routes/customer-pipeline.js`, `CustomerEditModal.jsx`, `CustomerDataPage.jsx` (`/customers`, Navbar link TP+lead) — Data khách hàng admin page (list/edit company_name+invoice fields+sales_id; soft-delete TP-only). GET returns sales JOIN + `job_count` (`LOWER(j.customer_name)=LOWER(cp.company_name)`). PATCH sales_id change → L14 transfer. Mounted at `/api/customer-pipeline` (avoids collision with `routes/customers.js`). Soft-delete via `deleted_at` + partial unique index (L17); invoice snapshot fields: **L15**. |
| EMAIL_SYSTEM | `/api/email/*` + `/api/users/me/gmail-setup` | `schema.sql` (`users.gmail_*`, `email_history`), `utils/encryption.js` (AES-256-GCM, key `GMAIL_ENCRYPTION_KEY` = 64 hex), `services/email-sender.js`, `routes/email.js`, `routes/users.js`, `ChangePassword.jsx` Gmail card, `TruckPlanningModal.jsx`. nodemailer Gmail SMTP via `POST /api/email/send-planning` (DD+TPL), `GET /api/email/history` (DD+TPL+lead); rendered VN subject/body for `mail_type ∈ ('new','cancel')`. Domain whitelist `@gmail.com`/`@googlemail.com`/`@slbglobal.com`. `email_cc` via L16. SMTP creds AES-256-GCM at rest (plaintext never logged). **Manual attachments (2026-06-30):** DD can attach ≤10 EXTRA files (≤15MB total, any type) via `InvoiceRecipientModal` 📎 picker — sent ALONGSIDE auto BBBG PDFs, **NEVER persisted** (`multer memoryStorage`, RAM only). `multer` mounted ONLY on `send-planning` (`.array('attachments',10)`, 15MB/file + handler-enforced cumulative ≤15MB → Vietnamese 400s); route JSON.parses stringified `invoice_info`/`booking_ids` + coerces boolean strings. `sendPlanningEmail` `extraAttachments=[]` pushed after the BBBG loop; `bbbg_attached`/`attachmentCount` use a pre-push `bbbgAttachedCount` (BBBG-only). `TruckPlanningModal.fireSend` builds FormData only when files present (else unchanged JSON). SLB identity in mail: SLB-identity Note. |
| SALES_REVENUE_TICK | `GET /api/jobs?tab={revenue_pending,revenue_entered}` + `PATCH`/`DELETE /api/jobs/:id/revenue-tick` | `schema.sql` (`jobs.revenue_entered_at`, `revenue_entered_by` FK, partial index `idx_jobs_revenue_status`), `routes/jobs.js` (4 tab modes; unified Sales guard L22), `SalesDashboard.jsx` Tab 3 "Quản lý công việc" + header card #7. Sales ticks completed LOG jobs "đã nhập thu" after entering revenue into external accounting software — **no amount stored**, just timestamp + user; un-tick anytime. Full spec: revenue-tick Note. |
| ADMIN | `/api/admin/users` + `/:id` + `/:id/{role,disable,enable,reset-password}` | `routes/admin.js`, `services/admin-guards.js`, `middleware/auth.js` (`requireAdmin`), `constants/roles.js`, `db/make_admin.js`, `AdminPage.jsx` (`/admin`), Navbar 🛡️ pill. Role `'admin'` = app-wide user administrator, above every dept (distinct from `truong_phong_log`). Router-gated `requireAuth+requireAdmin`. Create/reset-password return one-time temp password (bcrypt; never returns `password_hash`/gmail). Self-lock + last-admin invariants. `users.disabled_at` soft-disable (L32). Full spec: admin Note. See **L32–L34**. |

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

- React components: `PascalCase.jsx` (e.g. `CustomerDetailModal.jsx`); Pages: `PascalCase.jsx` in `src/pages/`
- Backend routes / DB scripts: `snake_case.js` (e.g. `pipeline.js`, `backfill_pipeline.js`)
- DB tables: `snake_case` plural (`customers`, `customer_pipeline`); columns: `snake_case`; FK columns: `<table_singular>_id`

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
9. **Always `railway up --detach` after every push.** Railway GitHub auto-deploy is **not active** (Settings → Source: "Auto deploy unavailable"). A commit pushed to GitHub but never `railway up`'d is invisible to production. Checklist in §7; rationale + verification in **L18**.

---

## 5a. Critical Lessons Learned

### L1 — Multi-row customer pattern
One `company_name` can have **multiple rows in `customers`** (one per report interaction). Never assume one customer = one row. When aggregating (counts, follow-up dates, quote counts) across a company, JOIN across all rows sharing `(user_id, LOWER(company_name))`, or use a correlated subquery spanning all matching rows.

### L2 — Two follow-up sources; always check both
Two independent follow-up sources: **Customer-level** = `customers.follow_up_date` + `follow_up_completed=FALSE`; **Update-level** = `customer_interaction_updates.follow_up_date` + `completed=FALSE`. Every follow-up stat query and drilldown filter **must check both** via `OR EXISTS` (counts) or `UNION ALL` (rows). Checking only `customers.follow_up_date` silently misses CIU-only follow-ups. Also: `c.interaction_type != 'saved'` must guard only the **customer-level branch** of the OR, not the top-level WHERE — a 'saved' customer with a CIU follow-up is still a valid pending task.

### L3 — Never use `toISOString()` for date comparisons; VN time on read AND write
`new Date().toISOString().slice(0,10)` returns the **UTC date**. In Vietnam (UTC+7) after ~5pm local, the UTC date is already tomorrow, mis-bucketing today's follow-ups. **Always** compute date strings from local parts:
```js
const localDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const today = localDateStr(new Date());
```
Apply the same local extraction when parsing server date strings for comparison.

**VN time applies to the WRITE/save path too (2026-06-15).** Company operates ONLY in Vietnam (`Asia/Ho_Chi_Minh`, fixed +07:00, no DST); storage is UTC `TIMESTAMPTZ`.
- **Frontend single source of truth** = `frontend/src/utils/dateFmt.js` — `fmtDate`/`fmtDateTime`(=`fmtDt`) format in `Asia/Ho_Chi_Minh`; **`toDatetimeLocal(stored)`** renders stored instant → VN `"YYYY-MM-DDTHH:mm"` for an input value; **`vnLocalToIso(naive)`** turns that back into a VN-anchored `"...+07:00"` ISO for the backend. NEVER re-copy these into a component (per-file copies use browser-local getters and drift). `localDateStr` stays on local parts (the sales compare path — do not change).
- **Backend single source of truth** = `backend/src/utils/vnTime.js` — `vnParts` + `fmtVnDateTime`(`DD/MM/YYYY HH:mm`)/`fmtVnDate`/`fmtVnHanLenh(val,importExport)` (L19 date-vs-datetime)/`fmtVnShortDate`/`fmtVnDeadline`, all `Asia/Ho_Chi_Minh`. The server runs in **UTC** on Railway, so `Date#getHours()/getDate()` and a **timeZone-less `toLocaleString`** print −7h / day-shift VN-midnight values. Importers: `services/email-sender.js`, `services/bbbg-pdf.js`, `routes/jobs.js`. **NEVER render a stored datetime on the backend with local getters or a timeZone-less `toLocaleString` — import `vnTime`** (L30). Frontend + backend runtimes are intentionally separate. TODO (audited, not migrated): `services/sea-quote-pdf.js` quote dates + cosmetic `new Date()` stamps in `bbbg-pdf.js`.
- **WRITE rule:** every datetime save must send a VN-anchored ISO (via `vnLocalToIso`), NOT a naive `"YYYY-MM-DDTHH:mm"` (naive is stored in UTC session TZ and reads back +7h shifted). Applies to `tk_datetime`, `tq_datetime`, `delivery_datetime`, `planned_datetime`, `actual_datetime`, `dd_completed_at`, TP `deadline`, `han_lenh` (export). `DateTimeInput24h` converts centrally on emit; inline `datetime-local` saves convert in their `save()`.
- **datetime-local inputs must be UNCONTROLLED** (`defaultValue` + read `ref.current.value` at save), never controlled `value={state}`. `datetime-local`'s `onChange` is unreliable → controlled state lags or is reset by a mid-edit refetch → the edit is silently dropped or saves `null`. Text inputs are fine either way. (The `tk_datetime` "saves but blank on F5" bug.)

### L4 — CHỜ FOLLOW drilldown uses UNION ALL, not DISTINCT ON
The `waiting_follow_up` drilldown returns **one row per follow-up task**, not per company — a company with two pending CIU dates appears twice (once per bucket). Intentional: each row is an action item. Query = `UNION ALL` of Source A (`customers.follow_up_date`, deduped per pipeline+date via `DISTINCT ON`) + Source B (`customer_interaction_updates.follow_up_date`, one row per CIU). Do not collapse back to DISTINCT ON per company (the original bug).

### L5 — Stat query and drilldown must use identical WHERE logic
If a stat counts a customer using condition X, the drilldown must include that customer using the same condition X. Any divergence (extra filters, missing OR branch, different date range) makes the count disagree with the modal rows. Rule: change stat + matching drilldown in the same commit, both ways. Also: **follow-up stats must NOT be filtered by `r.report_date`** — follow-up obligations are independent of when the report was filed.

### L6 — SQL alias names are the API contract; never rename them during debugging
No TypeScript / API schema / serializers here — the SQL `AS alias` name is consumed **directly** by field name in every frontend component. Renaming an alias silently returns `undefined` in JS (no error; `|| ''` fallback masks it; UI shows blank data). Bug example: renaming `customer_address → cust_address` broke `selectCustomer(c).customer_address` auto-fill silently.

**Rules:**
1. When debugging a query, **add** new fields alongside existing ones — never rename/remove existing aliases.
2. Safe pattern: `SELECT existing_col, existing_col AS _debug_raw` — keeps the contract, adds visibility.
3. Remove all `_debug_*` fields before committing.
4. Verify new-query alias names match exactly what the frontend reads before shipping.
5. When a field is NULL/empty and shouldn't be, check **which table the data actually lives in** before blaming the JOIN.

**Known high-risk aliases** (consumed directly by frontend — never rename):
- `GET /api/jobs/` → `tk_notes`, `truck_delivery_location`, `cus_name`, `ops_name`, `tk_status`, `tq_datetime`, `truck_completed_at`, `import_export`
- `GET /api/jobs/stats` → `total_pending`, `warn_soon`, `delete_requests`, `total_managing`, `sap_han`, `qua_han`
- `GET /api/jobs/customer-search` → `customer_address`, `customer_tax_code`, `pipeline_id`, `sales_id`, `sales_name`

### L8 — Detail modals must display ALL database fields comprehensively
When adding fields to jobs/job_tk/job_truck/job_ops_task, devs often update only the form+grid and forget the detail modal, which then falls behind schema by 10+ fields.
**Rules:**
1. If a field exists in the DB and the user fills it in, the detail modal must display it. No exceptions.
2. When adding a column to `jobs`/`job_tk`/`job_truck`/`job_ops_task`/`job_containers`/`job_assignments`, update `JobDetailModal.jsx` in the **same commit**.
3. Detail modals show ALL fields readonly — editing happens in dashboards.
4. Empty/null shows `—` (em dash); timestamps use `vi-VN` locale.
5. Sections: Thông tin chung / Lô hàng / Phân công / Tờ khai / Vận chuyển / Công việc OPS / Lịch sử thay đổi.

Also applies to `CustomerDetailModal` (Sales).

### L7 — Seed scripts must never DELETE users outside their own scope
`seed_users.js` once had `DELETE FROM users WHERE code != ALL(sales_codes)`, which deleted non-sales users; when LOG added cus/ops users with FK refs, the DELETE hit a FK violation → crash → Railway restart loop.
**Rules:**
1. Scope DELETE by role (`role IN ('sales','lead')`), never by exclusion of codes.
2. Each module's seed manages only its own roles.
3. When adding a module with new roles, audit all existing seed scripts.
4. Test `npm run db:seed` locally after adding roles. (See also L33 — a deploy-time seed must not delete admin-created users at all.)

### L9 — Full-system audit required before every commit
Changes often cover only the primary touch points; related queries/UI/modals get missed → inconsistency bugs (field saved but not displayed, API returns field but frontend ignores it, etc.).
**Rules (mandatory before every commit):**
1. **DB field (add/rename/drop column):** audit ALL SQL in `backend/src/routes/` touching that table (SELECT/INSERT/UPDATE/DELETE) + ALL frontend components destructuring that table.
2. **New/changed API endpoint:** grep all frontend callers (`api/index.js`, components); confirm they handle the new shape.
3. **Shared component (JobDetailModal, CustomerDetailModal):** list all importing pages; confirm prop changes don't break callers.
4. **Before `git commit`:** produce a "Files touched | Related checked | Gaps found" summary; fix any gap in the same commit; never commit with known gaps.
5. Applies to frontend + backend, all modules.

### L10 — Fix broadcast to similar patterns
Fixing a bug/feature in one role/component leaves the parallel dashboards (TP/CUS/OPS/DieuDo) silently broken.
**Rules:**
1. When fixing a pattern (clickable stat cards, inline editing, drilldown, button visibility), audit all similar components in the same commit.
2. Parallel dashboards (TP/CUS/DieuDo/OPS) get features consistently unless explicitly role-specific.
3. Grep for the same pattern across the codebase before committing; never fix in isolation when the pattern repeats.
4. Also applies to backend handlers with parallel structure (PATCH /tk, PATCH /truck, PUT /:id).

### L11 — Every job/customer list must have clickable rows
Drilldowns, stat-card drilldowns, and search results repeatedly ship without row-click handlers.
**Rules (all modules):**
1. Any list of jobs → each row clickable to open `JobDetailModal`.
2. Any list of customers → each row clickable to open `CustomerDetailModal`.
3. Applies to drilldowns, stat-card drilldowns, search results, notification/activity/history/filtered lists.
4. Inline action buttons in a row use `event.stopPropagation()`.
5. `cursor: pointer` + hover background to signal clickability.
6. Never ship a job/customer list without clickable rows — core UX contract.

### L16 — JSON-array text columns for small repeated values
For an unbounded list of small values (CC emails, tags) whose lifecycle matches the parent and that's never queried element-wise server-side, use a JSON-stringified array in a single TEXT column (not `TEXT[]`, not a child table).
**Concrete shape** (`transport_companies.email_cc`): schema `email_cc TEXT DEFAULT '[]'`; wire = array of strings, disk = JSON string (backend translates both ways); read helper `parseEmailCc` = `JSON.parse` with safe `[]` fallback on any error/non-array; write helper `prepareEmailCc` trims, drops empties, validates each via the scalar-email regex `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, returns `{ok,value}` or `{ok:false,badEmail}` → 400; frontend state keeps empty strings while editing, filter+validate on submit.
**Rules:**
1. Use JSON-array TEXT only when items are small, lifecycle matches parent, and you never need "any element matches X" (else child table / `TEXT[]`+GIN).
2. Always `JSON.parse` with try/catch + safe fallback.
3. Validate every element on write.
4. Empty-array default `'[]'` (not `''`/`NULL`) keeps the parse helper trivial.

### L17 — Soft delete + composite unique index needs a partial index AND matching ON CONFLICT predicate
Adding `deleted_at` to a table with a UNIQUE INDEX on `(col_a,col_b)` silently breaks two paths: (1) the unique index still enforces against soft-deleted rows, so re-creating a tombstoned pair fails or worse UPDATEs the tombstone via `ON CONFLICT DO UPDATE`; (2) existing `ON CONFLICT` clauses key off the non-partial index and error out once you make it partial.
**Pattern** (`transport_companies`, `customer_pipeline`):
```sql
ALTER TABLE x ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
DROP INDEX IF EXISTS idx_x_unique_cols;
CREATE UNIQUE INDEX IF NOT EXISTS idx_x_unique_cols_active ON x(col_a,col_b) WHERE deleted_at IS NULL;
```
Update every UPSERT to `ON CONFLICT (col_a,col_b) WHERE deleted_at IS NULL DO UPDATE`; add `AND deleted_at IS NULL` to every read that should hide soft-deleted rows.
**Rules:**
1. On adding soft-delete, immediately grep every reference to the table in `backend/src/routes/**/*.js`; each read needs `deleted_at IS NULL` unless it intentionally serves deleted rows.
2. Drop + re-create the unique index as partial in the same migration (don't leave both).
3. Update every `ON CONFLICT` clause with the matching `WHERE deleted_at IS NULL`.
4. Hard-delete + CASCADE is the valid alternative where retention isn't needed — choose deliberately.

Applies to: `customer_pipeline.deleted_at`, `transport_companies.deleted_at`, `reports.deleted_at` (L28). Candidate: `jobs.deleted_at`.

### L18 — Always deploy after push (Railway auto-deploy is unavailable)
Railway GitHub auto-deploy is OFF (Settings → Source: "Auto deploy unavailable"). `git push` ships to GitHub but does **not** trigger a Railway build — without an explicit `railway up --detach` the container keeps serving the old bundle.
**The atomic post-commit workflow — one unit, no skipping:**
```bash
git add <changed files>            # never git add -A
git commit -m "<descriptive msg>"
git push origin master
railway up --detach                # MUST DO — DO NOT SKIP
# verify: new route → curl -s -o /dev/null -w "%{http_code}\n" https://fwd-sales-production.up.railway.app/api/<probe>
#         expect 401 (route exists), NOT 200+HTML (SPA fallback = route missing)
#         frontend-only → re-fetch / and confirm assets/index-<hash>.js changed
# report actual verified state (bundle hash / image timestamp / feature check) — never "should be live now"
```
**Rules:**
1. Steps are ONE atomic unit; stopping after push is a half-shipped change — GitHub `master` and production diverge.
2. `railway up --detach` returns in ~5-15s (upload only); build+swap takes 2-4 min (`railway logs --build`).
3. Verification is mandatory — uploads can succeed while builds fail (broken `package.json`, missing env var, migration error). Green CLI exit ≠ live.
4. Never phrase test instructions as "After Railway redeploys…" (implies auto-deploy) — say "After `railway up --detach`…" or deploy yourself and report verified state.
5. Batched commits → one `railway up --detach` at the end ships all. Never push without a deploy.
- Doc-only changes still need `railway up` to keep the build-cache hash in sync, but skipping for a pure doc commit is acceptable IF the next code commit's deploy is guaranteed within minutes. **Long-term fix:** restore GitHub auto-deploy in Railway Settings → Source (then steps 5-6 stay mandatory, step 4 becomes the webhook).

### L19 — One column, two semantic meanings tied to a sibling column's value
Sometimes one DB column carries two different meanings by a sibling column. Canonical: `jobs.han_lenh` (TIMESTAMPTZ) — when `import_export='import'` it's *"Hạn lệnh"* (calendar date only); when `='export'` it's *"Cutoff time"* (precise datetime). Keep ONE column; branch UI + validation by the sibling (don't split into two columns unless the lifecycle truly diverges).
- **Storage:** one TIMESTAMPTZ. Date-only → store as midnight in project TZ (`'YYYY-MM-DD'` literal parses as session-TZ midnight).
- **Input type:** branch by sibling (`<input type="date">` vs `datetime-local`); on toggle, datetime→date slice off `T...`, date→datetime append `T00:00`.
- **Display:** branch label AND format (`'Hạn lệnh'/fmtDate` vs `'Cutoff time'/fmtDt`); generic column header "Hạn lệnh / Cutoff".
- **Validation:** branch the error message; same truthy check (`!value`).
- **Backend "missing_fields" strings:** nested `CASE WHEN sibling='X' THEN 'LabelA' ELSE 'LabelB' END`.

Touch points (`han_lenh`+`import_export`): `CreateJobModal`, `JobDetailModal`, `LogDashboardTP`+`JobListModal` (cell renderer branches), `LogDashboardCus.getMissingFields`, `routes/jobs.js` POST validation + SQL drilldown CASE.
**Rules:**
1. Adding such a column → write a one-line note naming column+sibling+the two meanings.
2. Don't split into two columns unless lifecycle diverges.
3. Audit ALL display+validation surfaces in the same commit (L9).
4. If a write path (PUT /:id) doesn't enforce the sibling-aware required rule, document that asymmetry explicitly.

### L20 — M:N booking-container pattern + derived status function
Multi-truck semantics don't fit 1:1 `job_truck`. One job can split across carriers; a container belongs to at most one carrier at a time.
**Pattern:** `truck_bookings` (parent, one row per carrier-plan; carrier, planned datetime, delivery location, cost, vehicle, notes, `deleted_at`) + `truck_booking_containers` M:N link `(booking_id, container_id)` with **`UNIQUE(container_id)`** = the load-bearing invariant ("one container ↔ one active booking" is a DB constraint, not app logic). Re-assign = delete+re-insert the link row. `job_truck` left in place but **deprecated**.
**`get_truck_booking_status(p_job_id INT) RETURNS TEXT`** (plpgsql, single source of truth — so the 4 dashboards can't drift). States: `no_containers` (0 job_containers) · `chua_dat_xe` (has conts, 0 active bookings — DD must book) · `dat_xe_1_phan` (some booked, some loose) · `da_dat_xe_du_cho_so_xe` (all booked, some missing `vehicle_number`) · `da_giao_xong` (all booked + every booking has `vehicle_number`). Soft-delete filters throughout (`tb.deleted_at IS NULL`); partial unique index (L17). (DD-done split state `dd_da_xong` added in L25.)
**Rules:**
1. Whenever a job-level decision (who hauls, when, where, cost) can split across carriers, use `parent + M:N link` — never pile multi-carrier semantics onto a 1:1 table.
2. The UNIQUE on the link's child column is load-bearing (prevents double-booking in the DB).
3. Derived states combining table counts belong in a plpgsql function called from SQL, not JS.
4. Introducing a replacement for a table → **deprecate, don't drop**; drop only when grep returns zero readers.

### L21 — Mobile-first responsive UI (Phase 1 baseline)
**Every new UI feature MUST be responsive from day 1.** Breakpoints: Desktop ≥1024px · Tablet 768–1023px · Mobile <768px.
**Shared utilities in `frontend/src/index.css`** — use, don't redefine: `.stat-grid` (stat-card grids); `.form-grid-2/-3/-4/-5` (modal form grids); `.navbar-desktop-items`/`.navbar-mobile-right`/`.navbar-hamburger`/`.navbar-mobile-menu` (Navbar only).
**Rules:**
1. New pages: design mobile-first (375px), then enhance for desktop (L9 audit catches the gap).
2. New modals: **Pattern A** `<div className="modal-overlay"><div className="modal modal-lg">…`. Never inline `position:fixed;inset:0` (Pattern B bypasses the mobile bottom-sheet rule).
3. New stat grids: `.stat-grid` (not inline `gridTemplateColumns`).
4. New modal form grids: `.form-grid-N`; the only accepted inline exception is a `'90px 1fr 1fr'` label+2-input row (`CreateJobModal.jsx:539`) — verify mobile readability.
5. Touch targets ≥ 36×36px; bare icon buttons need `padding:8px`.
6. Mobile inputs: `width:100%; max-width:<cap>; min-width:0; box-sizing:border-box`. Never hard-pin `width:<px>` on inputs that may sit in the mobile-menu dropdown.
7. Pop-out dropdowns positioned via `getBoundingClientRect()` cap with `maxWidth: 'min(<max>px, calc(100vw - 32px))'`.
**Deferred to Phase 2/3** (don't retrofit unless scoped): `JobDetailModal` split-pane; big data tables (keep horizontal scroll, Card view later); `CreateJobModal:539` 3-col cont row; `QuoteForm` 4-col PA rows; touch replacement for `title=` tooltips on `CustomerDataPage`.

### L22 — Tab modes on a polymorphic GET endpoint demand role-scoping consistency across ALL modes
`GET /api/jobs` had `pending`/`completed`; the `completed` branch skipped role-scoping ("all LOG roles see all completed jobs") — correct for LOG but it silently let a `role='sales'` user see every sales' completed jobs. Latent data-exposure until M2's new tabs forced an audit.
**Rule:** when adding a tab mode, audit ALL existing tab branches for role-scoping consistency BEFORE adding the new branch. Sales filtering is almost always wanted-on-every-tab; LOG role filtering is sometimes per-tab.
**Shape** (`routes/jobs.js GET /`): hoist role scoping ABOVE the per-tab `if/else` — `if (role==='sales') conditions.push('j.sales_id=$n')` fires on every tab; per-tab branches add only tab-specific predicates (date range, status, `revenue_entered_at IS NULL`) + tab-aware ORDER BY. LOG "see all on completed" is now visible at the top by intentional omission (document why at the omission site).
**Rules:**
1. Adding a tab mode → audit all existing tab branches for the targeted role.
2. Role filter that applies to every tab → hoist ABOVE the tab branching.
3. Role filter intentionally per-tab → document why at the omission site so an audit doesn't "fix" it.
4. Same pattern for drilldown/search/any polymorphic SELECT branching on a query param.

### L23 — MCP server (Windows) — wrap an npm `.cmd` in `cmd.exe /c`
An MCP server (`C:\Users\HP\.claude.json`) launching an npm CLI fails in two layers: bare name → `spawn ENOENT` (resolves to the extension-less Unix script); direct `.cmd` → `spawn EINVAL` (Node refuses to spawn `.cmd`/`.bat` without `shell:true`, CVE-2024-27980) — the ECC `mcp-health-check.js` hook uses a plain `spawn`, so it keeps quarantining the tools.
**Fix — wrap in `cmd.exe` (a real `.exe`):**
```json
"codegraph": { "type": "stdio", "command": "C:\\Windows\\System32\\cmd.exe",
  "args": ["/c", "C:\\Users\\HP\\AppData\\Roaming\\npm\\<tool>.cmd", "<tool args...>"] }
```
**Process:** edit `.claude.json` directly with double-escaped `\\` (not `claude mcp add/remove` — it strips backslashes on Windows); validate JSON still parses; reload via `/mcp` → Reconnect; the ECC quarantine clears on the next live probe.
**Rules:**
1. Windows MCP server launching an npm CLI must use `cmd.exe /c <tool>.cmd` — never a bare name, never a direct `.cmd` path.
2. Verify the `.cmd` sibling exists first (`dir <npm-prefix>\<tool>*`).
3. `ENOENT`/`EINVAL` on an MCP tool → the hook's `spawn()` call is at fault; check the `command` shape first.

### L24 — `checkAndCompleteJob` is defined in TWO files — confirm the canonical one before editing completion logic
Same function name in two files: `routes/jobs.js:44` `(client, jobId, changedBy)` (suspect — stale duplicate or thin wrapper) vs `services/job-completion.js:14` `(client, jobId, changedBy, recordHistory)` (**canonical Phase-4 version**, called from `PATCH /api/truck-bookings/:id`). Completion fixes must target the canonical `services/job-completion.js`; fixing `routes/jobs.js:44` in isolation silently diverges (L9/L10). **TODO (deferred, needs `codegraph_impact` first):** map callers, confirm whether `routes/jobs.js:44` is a thin wrapper or a stale copy, consolidate.
**Rules:**
1. Before editing job-completion code, confirm you're in `services/job-completion.js` (canonical).
2. Don't "fix" `routes/jobs.js:44` in isolation — broadcast/consolidate (L10).
3. Any symbol `codegraph_search` returns from two files = a duplication hazard; resolve canonical before editing.

### L25 — DD completion split: `dd_completed_at` separates DD-done from job-done
(2026-05-24) DD's "TH ngày giờ" no longer stamps `jobs.completed_at` directly. Whole-job completion is derived from CUS+DD+OPS all done via `checkAndCompleteJob` (now alive for all 3 service_types — was dead for truck/both due to circular `truckDone='hoan_thanh'`).
**Schema** (`jobs`): `dd_completed_at TIMESTAMPTZ NULL` + `dd_completed_by INT FK users(id) ON DELETE SET NULL` + `idx_jobs_dd_completed_at` partial index. One-shot idempotent backfill set `dd_completed_at=completed_at` for 23 historical truck/both jobs.
**`get_truck_booking_status`:** `'hoan_thanh'` unchanged (driven by `jobs.completed_at IS NOT NULL`); NEW `'dd_da_xong'` = `dd_completed_at IS NOT NULL AND completed_at IS NULL` (DD done, job pending CUS/OPS; teal "DD đã xong") — makes `truckDone` reachable for pending truck/both.
**`checkAndCompleteJob`:** `truckDone = ['dd_da_xong','hoan_thanh'].includes(status)`; handles `tk`→tkDone, `truck`→truckDone, `both`→both, plus `checkOpsTasksDone` for HP; auto-flips `status='completed'`+`completed_at=NOW()` only when all required depts done.
**`PUT /api/jobs/:id` body `{completed_at}`:** stamps `dd_completed_at`+`dd_completed_by` (NOT `completed_at`+`status`); keeps DD prerequisite guards; calls `checkAndCompleteJob` after; returns `{dd_completed, job_completed}` for the right toast. Uncomplete (`completed_at:null`) clears `dd_completed_at`/`by` only (don't auto-uncomplete the whole job).
**Companion:** `checkOpsTasksDone(client, jobId) → {ready, missing}` in `services/job-completion.js` — single source of truth for the per-task OPS done predicate, used by both the auto path (tk) and the DD PUT path.
**Rules:**
1. Adding a dept-level completion stamp → mirror this: separate `*_completed_at`+`*_completed_by` on `jobs` + a `get_truck_booking_status` state if it affects truck progression.
2. Don't conflate "this dept finished" with "whole job finished" — downstream consumers (Sales revenue-tick, KT) key off whole-job `completed_at`.
3. **Every reader for a dept reads that dept's `<dept>_completed_at`** — display, input `value`, and partition. (Bug 2026-06-15: DD "TH ngày giờ" cell bound `value` to `j.completed_at` and showed blank on reload; must bind `j.dd_completed_at`.)

### L26 — Per-dept status columns + tab filters (cross-dashboard pattern)
(Owner spec 2026-05-25) Each dashboard's "Trạng thái" column reflects ONLY that dept's scope, and the tab filter partitions by that dept's own done-state — NOT by `jobs.status`.
- **OPS:** own work only (cost TQ, đổi lệnh, cost ĐL); 2 khu; no "Chờ" column. **DD:** own work + CUS thông quan? + OPS đổi lệnh?; "Chờ" column shows blockers; only "Đang làm"/"Hoàn thành" tabs. **CUS:** own work + downstream done?/not; "Chờ" column shows downstream waits. **TP:** all depts in detail (up to 3 stacked lines CUS/DD/OPS; all done → green "Hoàn thành"); no "Chờ" column.
- **Tab filter = frontend-only partition:** "Đang làm" = ≥1 BP in this dept's scope pending; "Hoàn thành" = this dept's scope fully done (merge `pendingJobs.filter(deptDone) ∪ completedJobs.filter(isMyJob)` to cover the last-tick→auto-flip race). Scope to the dept's `service_type`. No new backend tab params (backend stays `pending`/`completed`).
- **Shared helpers:** `ddPillInfo`/`ddPillStyle` in `frontend/src/utils/truckBookingStatus.js` (DD + TP). Each dashboard keeps its own dept-status helpers (`cusStatusInfo`/`cusWaitingStatus`/`cusIsDone`; `opsStatusKhu1/2`+done predicates; `tpStatusLines`+`TpStatusCell`; DD `waitingStatus`).
- **GET `/api/jobs` aggregates:** `bookings_total_alive`, `bookings_with_invoice_lifting`, `bookings_with_cost_entered` — feed `ddPillInfo` sub-states.
**Rules:**
1. Status-column helper defined at module level in that file (or `utils/` if 2+ dashboards reuse).
2. Tab filter stays a frontend partition; don't proliferate backend tab modes.
3. **Each dashboard column has BOTH a desktop `<td>` and a mobile equivalent in `renderMobileCard`; cell count must match the column array length** (mismatch = misalignment).
4. A column reading a field not yet in the GET projection → add the SELECT first; never ship a column rendering `undefined`.

### L27 — Quote calc + PDF are a SINGLE parametric engine, not per-transport copies
Copying `sea-quote-pdf.js → air-quote-pdf.js` reintroduces every sea-side fix (the 2026-05-27 air regression: cell renderer kept `isCont = basis==='cont'` so air rate-break rows rendered `—`). Copying *creates* the divergence.
**Pattern (enforced):**
1. **Shared calc `seaQuoteCalc.{js,cjs}`** parametric over a dimension (sea: `containers[{type,qty}]`; air: `rate_breaks[{break,kg}]`). Helpers normalize both: `rateByDim(row)`, `ctxDimensions(ctx)`, `rowUsesDimensions(row,ctx)`. `calcRowAmount` has ONE branch — no transport-specific path.
2. **`sea-quote-pdf.js` is the SINGLE generator** for both; air/sea differ only in labels (POL/POD vs AOL/AOD via `drawPartiesRoute` on `opts.transport`; FCL/LCL vs AIR; SL vs kg sub-header; `formatVolume`). Cell renderer uses `rowUsesDimensions` — NEVER `if (transport==='air')`.
3. **Form + Display** (`SeaQuoteForm`/`Display` + `AirQuoteForm`/`Display`) separate files but both import the same shared calc; money columns must never have transport-specific copies.
**Rules:**
1. **New transport (road/rail/multimodal) = add a config, NEVER copy a file:** add unit tokens to `unitBasis()`, a dimension case to `ctxDimensions()`, a label config to `drawPartiesRoute()`. Calc/cell/totals/PDF all work with no new code.
2. **Forbidden:** `if (ctx.transport==='air')` in cell renderers; creating `air-quote-pdf.js`; copy-pasting `calcRowAmount`.
3. **Self-check invariant:** `calcSectionTotals(rows,ctx)[cur].total === Σ calcRowTotal(row,ctx)` per currency.
4. **Display filter:** PDF+form+display show ALL `r.ticked` rows even when `calcRowAmount===0` (user explicitly ticked it).

Applies to: `frontend/src/utils/seaQuoteCalc.js`, `backend/src/utils/seaQuoteCalc.cjs`, `backend/src/services/sea-quote-pdf.js`, any `*QuoteForm/Display`.

### L28 — Reports soft-delete + audit-preserving delete-approval (2026-05-29)
Two Golden-Rule-#1 fixes ship together.
**Part A — `reports.deleted_at`.** `DELETE /api/reports/:id` used to hard-delete + cascade (`reports → customers ON DELETE CASCADE`), wiping the interaction audit trail. Now:
```sql
ALTER TABLE reports ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
CREATE INDEX IF NOT EXISTS idx_reports_deleted_at ON reports(deleted_at) WHERE deleted_at IS NOT NULL;
```
DELETE = `UPDATE reports SET deleted_at=NOW() WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`. Customer rows preserved. **15 read-sites guarded** with `r.deleted_at IS NULL` (full L9 audit): `routes/reports.js` (GET `/` list+count, GET `/:id`), `routes/stats.js` (all 6 main stats + per-sales breakdown + drilldown `quoteSelect`/`custSelect`), `routes/pipeline.js` (`lead-all` + LATERAL, GET `/`, PUT `/:id/info`, GET `/:id/detail`), `routes/customers.js` (GET `/`, GET `/:id`), `db/backfill_pipeline.js` (`STAGE_CTES`). **Intentional non-guards (don't "fix"):** the follow-up IIFEs in `stats.js` read `FROM customers c` without joining reports — soft-deleted reports' customers still surface for follow-up (audit-preserving: obligation belongs to the interaction).
**Part B — pipeline approve-delete is soft-delete too.** `POST /api/pipeline/delete-requests/:id/approve` = `UPDATE customer_pipeline SET deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL` (partial-unique-index revival per L17); CIU rows intentionally NOT wiped (audit); `pipeline_delete_requests.status` explicitly flipped to `'approved'` (+`reviewed_at`/`reviewed_by`) since the old FK cascade no longer fires.
**Rules:**
1. New soft-delete on a table with join-accessed children → grep every `FROM`/`JOIN <table>` in `backend/src/**/*.js`, add `deleted_at IS NULL` in the same commit.
2. Decide per-read whether to hide or surface soft-deleted rows; document audit-preserving exceptions inline.
3. Hard→soft conversion on a table that cascaded → audit every dependent cleanup + the FK chain.
4. Partial unique indexes (`WHERE deleted_at IS NULL`) are mandatory on any UNIQUE-constrained soft-delete table (L17).

### L29 — Multi-table writes need transactions when downstream invariants depend on sibling state
Golden Rule #4 mandates transactions; two 2026-05-29 violations show *why*. **A:** `PUT /api/quotes/:id` booked-promotion ran 3 sequential `db.query` (quotes → customer_pipeline → pipeline_history); a mid-failure leaves stage='booked' with no audit row, or a booked quote whose pipeline still shows 'quoting'. **B:** `POST /api/pipeline/customers/:id/updates` did CIU INSERT then `last_activity_date` UPDATE; a mid-failure leaves the note saved but `last_activity_date` stale → `applyAutoTransitions()` wrongly flips a just-active customer to `dormant`.
**Sharper test than "2+ tables":** does a derived stat / auto-transition / downstream invariant read a **sibling column** this write also mutates? If yes, the writes MUST be one transaction.
```js
const client = await db.pool.connect();
try { await client.query('BEGIN'); /* all writes via client.query; early-return paths ROLLBACK too */
      await client.query('COMMIT'); res.json(result); }
catch (err) { await client.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
finally { client.release(); }
```
**Rules:**
1. 2+ table writes → `pool.connect()` + BEGIN/COMMIT/ROLLBACK + `release()` in `finally`.
2. Every early-return inside the try (404, ownership, validation) must ROLLBACK first (else a leaked open transaction stalls the next request on that client).
3. Switch `db.query` → `client.query` for every statement inside the transaction (a stray `db.query` runs outside it).
4. New write path touching a column another path *reads* for a derived state (`last_activity_date`→dormant; `pipeline.stage`→stats; `truck_booking_status`→DD pill) → expand the existing transaction.

### L30 — Shared helpers live in `services/` / `constants/` / `utils/`, never re-copied per file
Copy-pasted helpers silently diverge (the L24/L10 failure mode for small utilities). CỤM 2 (2026-06-01) found: `recordHistory` in 2 files with 2 policies; role arrays in 2-3 files; `fmtDate`/`fmtDt` in 17 frontend files diverged into 5 output formats.
**Canonical homes:** backend cross-cutting logic → `backend/src/services/` (`job-history.js` `recordHistory` skip-no-op canonical; `job-completion.js` `checkAndCompleteJob`); backend constants/ACL → `backend/src/constants/roles.js` (`LOG_ROLES`, `PLAN_ROLES`, `CUS_ROLES`, `AUTO_CUS_ROLES`, `WRITE_ROLES`, `SALES_ROLES`, `LEAD_ROLES`, `KT_ROLES`, `canWrite`); frontend formatters/pure helpers → `frontend/src/utils/` (`dateFmt.js`, `seaQuoteCalc.js`, `truckBookingStatus.js`).
**Rules:**
1. A helper used by 2+ files MUST live in `services`/`constants`/`utils` and be imported. Before writing `function fmtX`/`const X_ROLES`/`recordY`, grep the name; import if it exists.
2. Unify on a single semantic deliberately, and document why (e.g. `recordHistory` → skip-no-op).
3. **Preserve exact output when the divergence is real** — `dateFmt` kept all 5 formats as separate exports (`fmtDate`, `fmtDatePadded`, `fmtDateTime`, `fmtDateTimeYear`, `fmtDateTimeDateFirst`, `localDateStr`), each call site importing the variant matching its old output (often aliased, `import { fmtDateTime as fmtDt }`). A dedup must NOT silently change what the user sees — ask before collapsing genuinely-different copies.
4. **Exception — per-file label/color/display-enum maps stay local** (`STAGE_INFO`, `STATUS_LABEL`, etc. — see `frontend/src/CLAUDE.md`). This lesson is about logic/formatters/constants, not display enums. **`deadlineStyle` (per-file) is intentionally NOT centralized** — the CUS-overdue gate (below) wraps it at call sites, leaving the helper untouched.

### L31 — `ops_hp` service_type (OPS-only job) + the service_type ripple list
(Shipped 2026-06-06) `service_type` has 4 values: `tk`/`truck`/`both`/`ops_hp`. **`ops_hp`** = OPS-only, HP-only, free-text `jobs.ops_hp_note`; auto-assigns OPS like a normal HP job; seeds ONE `job_ops_task` `task_type='ops_hp'` and nothing else (no `job_tk`, no `dieu_do_id`, no thong_quan/doi_lenh). **Cost required before completion.**
- **Completion (load-bearing, `services/job-completion.js`):** `checkAndCompleteJob` has an `ops_hp` branch (`ready=true`, gated solely by `checkOpsTasksDone`) — without it the `if/else` chain falls through and the job never completes. **Any future 5th service_type MUST add its own branch here.** `checkOpsTasksDone` recognizes `ops_hp` (`ohRequired = task exists`; `ohDone = completed && cost_entered_at`; no task → `ohRequired=false`, so tk/truck/both unaffected). `OPS_DONE_TASK_TYPES=['doi_lenh','ops_hp']` gates `/done`; `OPS_TASK_TYPES` (for `/cost`) also gains `ops_hp`; `thong_quan` stays cost-only.
- **Post-completion is service_type-agnostic** — Sales revenue-tick + the KT chain key purely on lifecycle timestamps; zero `service_type`/`job_tk`/`truck` filtering. **Never add `service_type` checks to `routes/accounting.js` or the revenue-tick path.**
- **`tpStatusLines` trap:** if it emits `[]` for a pending job, TP renders a false green "Hoàn thành" **and the job drops out of TP's pending tab**. Any service_type not covered by the tk/truck/HP branches must add its own line.

**The service_type ripple list — 11 touch-points** (⚠ = silent-break if skipped):
1. `schema.sql` — DROP/ADD `jobs_service_type_check` (+ any new column). ⚠ inline CHECK only affects fresh DBs.
2. `services/job-completion.js` — `checkAndCompleteJob` branch (⚠ no branch = never completes) + `checkOpsTasksDone` if OPS-gated.
3. `routes/jobs.js` POST `/` — destructure + INSERT column + `VALUES ($n)` + params (⚠ all three) + routing flags + task seeding + `suggestOps`/`suggestCus` guards.
4. `routes/jobs.js` PUT `/:id` — new column in `FIELDS` + service_type validation.
5. GET `/` + GET `/:id` — `j.*` auto-returns new columns (change only for a derived alias).
6. `/filtered` + `/stats` + `/waiting-*` — ⚠ explicit column lists + `service_type IN (...)` gates; extend where the role needs the work.
7. `CreateJobModal.jsx` — `INIT_FORM` + select option (+ conditional visibility) + submit validation + `hasUserInput` dirty-guard + null-coerce.
8. `JobDetailModal.jsx` — `buildDraft` + readonly Row + edit input (L8) + `SVC_LABEL`.
9. Each dashboard (`LogDashboard{TP,Cus,Ops,DieuDo}.jsx`) — tab/filter + column array + matching `renderMobileCard` (L26); `tpStatusLines`.
10. `SVC_LABEL` ×6 — `SalesDashboard`, `AccountingDashboard`, `LogDashboardTP`, `LogDashboardCus`, `AssignmentModal`, `JobDetailModal` (⚠ else raw string shows).
11. `JobListModal.jsx` / BBBG — drilldown column rendering; BBBG only if the type prints to BBBG.
**Rules:**
1. The completion gate (#2) makes-or-breaks a new type — verify a fresh job can reach `status='completed'` before shipping UI.
2. `tpStatusLines` (#9) is the silent-visibility trap — always add a line.
3. Post-completion (Sales/KT) needs no change — keep it that way.
4. Grep every `service_type IN (...)` when adding a type; include only where the role needs the work; document intentional omissions.

### L32 — Soft-disable (`disabled_at`) must be filtered in EVERY staff-enumerating query
Checking `users.disabled_at` only at login + `requireAuth` blocks access but leaves the disabled user in every auto-assign pool, workload view, stat, picker, and notification recipient list. "Khóa" must mean removed-from-operations, not just can't-sign-in.
**Rule:** every query that lists/picks users by role MUST add `AND disabled_at IS NULL`. Grep `role = ANY`/`role IN`/`role =`; no staff-enumerating query may omit it.
**Sites filtered (2026-06-11):** `services/ai-assignment.js` `suggestCus` (`role = ANY(AUTO_CUS_ROLES) AND disabled_at IS NULL` — supervisor excluded, L34) + `suggestOps`; `routes/jobs.js` `queryCusStaffStats`/`queryDieuDoStaffStats`/`queryOpsStaffStats`, `GET /staff-workload`, `GET /users/log-staff`, `GET /overview` staff distribution, DD round-robin on create, all 3 TP-notification recipient lookups.
**P2 companion:** `validateAssignee(client, userId, allowedRoles, label)` rejects a `cus_id`/`ops_id` that is missing, disabled, or wrong-role — wired into `assign`, `manual-assign`, `reassign-cus`, `reassign-ops`. Applies to: `users.disabled_at`.

### L33 — The seed must NEVER overwrite or delete admin-controlled state on existing users
`start.js` runs `seed_users.js` (+ KT seed) every deploy. Two mechanisms reverted admin actions: `ON CONFLICT (username) DO UPDATE SET role=EXCLUDED.role` overwrote admin role changes (and the KT seed clobbered self-set `gmail_address`); `DELETE FROM users WHERE code != ALL($seedCodes) AND role IN ('sales','lead')` deleted admin-created sales/lead users (also the L7 FK/restart-loop risk).
**Rule:** an idempotent every-deploy seed may ONLY (a) INSERT users that don't exist yet, and (b) refresh purely-cosmetic fields (`name`/`code`/`avatar_color`) on conflict. On an existing user it must NEVER overwrite `role`/`password_hash`/`gmail_address` and must NEVER hard-delete. Removing a user = the admin panel's **disable** (soft, reversible), never a deploy-time op.
**Fixed (2026-06-11/12):** `seed_users.js` + `seed_ke_toan.js` `ON CONFLICT SET` = `name`/`code`/`avatar_color` only; all `seed_users.js` DELETEs removed. Applies to: `seed_users.js`, `seed_ke_toan.js`.

### L34 — CUS auto-assign targets `AUTO_CUS_ROLES` (cus1/cus2/cus3); bare `'cus'` is a supervisor, NOT auto-assigned
`AUTO_CUS_ROLES = ['cus1','cus2','cus3']` = the 3 customs *workers* in the round-robin pool. `CUS_ROLES = ['cus','cus1','cus2','cus3']` additionally includes bare `'cus'` = the **Giám Sát CUS supervisor** (reviews work, NOT in the pool). Don't conflate the two constants.
**Rule:**
- **Auto-assignment pool** → `AUTO_CUS_ROLES` (supervisor excluded). Only site: `suggestCus` in `services/ai-assignment.js`.
- **Everything else** (view/edit checks in `job-access.js`, dashboard/filter/permission branching in `jobs.js`, `queryCusStaffStats`, MANUAL-assign `validateAssignee`) → `CUS_ROLES`, so the supervisor still sees CUS jobs, appears in workload, and is a valid *manual* target. Never re-introduce the `('cus1','cus2','cus3')` literal — import the constant.

Adding a PERSON to an existing worker role is data-driven; a new CUS *role token* (`cus4`) needs the `users_role_check` CHECK + `roles.js` edits.

### L35 — `service_type`/`destination` edits reconcile every side via ONE helper (`services/job-reconcile.js`)
`PUT /api/jobs/:id` originally only ADD-back-filled and never cleaned a *dropped* side. Since the DD/CUS/OPS dashboards select by **assignment** (`ja.dieu_do_id`/`cus_id`/`ops_id`) with no/partial `service_type` filter, dropping a side orphaned rows on the wrong dashboard; gaining the truck side never assigned a DD → invisible work.
**Fix (2026-06-16) — single source of truth `reconcileJobSides(client, jobId, {oldSvc,newSvc,oldDest,newDest,cusSuggestion,actingUserId,customerName,jobCode})`** in `services/job-reconcile.js`, called once by `PUT /:id` after the field UPDATE (replaced the 3 old inline blocks — don't re-add per-direction patches). Derives desired sides from the NEW state and reconciles each:
- **TK side** desired = `newSvc ∈ {tk,both}`. Gain: ensure `job_tk`; if `cusSuggestion` present (auto) assign `cus_id` (+notify/history) else → `waiting_cus`. Lose: clear `cus_id` + delete the empty `job_tk`.
- **TRUCK side** desired = `newSvc ∈ {truck,both}`. Gain: DD round-robin (mirrors POST create) → `dieu_do_id`+notify; no active DD → the new `waiting_dd` TP stat. Lose: Option-B per live booking (L20) + clear `dieu_do_id` + legacy `job_truck`.
- **OPS side** destination-aware: `thong_quan` desired = HP & tk/both; `doi_lenh` desired = any HP job (but see LCL rule — OPS rotation Note). Gain: ensure rows (`ON CONFLICT DO NOTHING`). Lose: remove the unneeded task type.
**The 3 destroy-guards (LOSE never silently destroys committed/sent/completed work; run in a GUARD PHASE before any write; helper returns `{blocked,status,code,error}` → caller ROLLBACKs):**
1. **TRUCK sent-mail BLOCK** — truck-lose with a live booking whose `mail_group_id IS NOT NULL` → `409 TRUCK_BOOKING_MAILED` ("HỦY booking trước"). No cancel-mail inline (SMTP must not run in the txn).
2. **TK-progressed BLOCK** — tk-lose with a `job_tk` that progressed (`tk_status≠'chua_truyen'` OR any of `tk_number`/`tk_datetime`/`tq_datetime`/`delivery_datetime`/`completed_at` set) → `409 TK_WORK_IN_PROGRESS`.
3. **OPS-completed KEEP** — removing an already-`completed`/`cost_entered` ops_task → KEEP it + `recordHistory('ops_task_kept_completed')` instead of deleting.
The **CUS suggestion is computed BEFORE BEGIN** (suggestCus is a network call — keep it out of the txn) and passed in. Belt-and-suspenders: DD stats/pending still filter `service_type IN ('truck','both')`; `waiting_dd` = `service_type IN ('truck','both') AND dieu_do_id IS NULL AND status='pending'`.
**Rule:** whenever a job dimension driving a dept's assignment-scoped dashboard can be edited away, reconcile that side in `reconcileJobSides` (gain → back-fill+assign, lose → clean+clear behind a destroy-guard). Assignment-scoped dashboards don't self-correct.
**Follow-up (documented, not done):** the DD round-robin SQL + Option-B booking-delete are replicated between `job-reconcile.js` and POST create — consolidate into a shared service (an L30 dedup that touches POST).

---

### Note — OPS per-task assignment + weekly rotation (functionally complete)
OPS work is assigned **per-task** with a **weekly rotation** between 2 OPS users. Each `job_ops_task` carries its own owner (`ops_id` + `assigned_at`/`assigned_by`); the `thong_quan` owner and the `doi_lenh` owner of the same `both` job see & tick ONLY their own task.
- **Rotation source of truth** = `backend/src/services/ops-rotation.js` `getWeekRotation(date, db) → {thongQuanOpsId, doiLenhOpsId}` (L30 single home). ISO week (Mon–Sun) computed on the **VN-local** day via `vnTime.vnParts` + a `Date.UTC` anchor (L3 — the Sun→Mon flip is VN-midnight). Even week → `{tq:a, dl:b}`; odd → swapped. The `doi_lenh` person also owns `viec_khac` + `ops_hp`. **L32 fallback:** NULL/disabled slot → lowest-id active OPS; one active OPS → both roles collapse to it; zero → `{null,null}` + warn. The rotation **pair lives in `log_settings.ops_rotation_a`/`ops_rotation_b`** (INTEGER FK, `ADD COLUMN IF NOT EXISTS`, seeded ONCE from the two lowest-id active OPS via COALESCE — never clobbers an admin value, L33). Week-flip keeps each task's stored owner (no recompute, no cron).
- **Creation** (`jobs.js` POST `/`, auto mode): `getWeekRotation(new Date(), client)` stamps each task's `ops_id` (`thong_quan`→tq owner; `doi_lenh`/`ops_hp`→dl owner). `suggestOps` remains only the fallback when rotation can't resolve a pair.
- **Reads are per-task** (`job_ops_task.ops_id`): dashboard list filter (`EXISTS(jot WHERE ops_id=me)`), the 5 OPS header counts, `queryOpsStaffStats` (`COUNT(DISTINCT j.id)`), both drilldown handlers (owner-scoped, L5), tick-auth (each of the 4 tick endpoints: `ctx.task_ops_id !== req.user.id → 403`). Idempotent migration backfill sets legacy tasks (`assigned_at IS NULL`) `ops_id = ja.ops_id` so every currently-visible job stays visible. `LogDashboardOps.jsx`: `getMyTask(j,type,uid)` threads `uid`; tick buttons render only for the owned task. A shared `both` job counts in BOTH owners' `total_managing` (per-user, never globally summed).
- **`ja.ops_id`** is kept as a **deprecated cosmetic primary pointer** (TP "OPS" column, JobDetailModal `ops_name`, `waiting_ops` "no OPS", `/overview` staff-distribution) — does NOT affect OPS visibility/ticks. `resyncJaOpsPrimary` = doi_lenh→thong_quan→ops_hp COALESCE.
- **TP per-task OPS UI** (`LogDashboardTP.jsx`, HP jobs only): 3 columns **Thông quan**/**Đổi lệnh**/**Việc khác** driven by `j.ops_tasks[]` (each cell: assignee + status chưa làm/chưa cost/xong; empty slot when no such task). Reusable `OpsTaskCell` (desktop `cell()` + mobile card, L26; `readOnly` param for KT). Per-task reassign: click a filled cell → `ReassignModal` → **`PATCH /api/jobs/:id/ops-task/:taskType/assign`** (TP-only, `validateAssignee ['ops']` L32) sets ONLY that task's `ops_id` + resyncs `ja.ops_id` + notifies; touches no other task. **"+ đổi lệnh"** on an empty doi_lenh cell → **`POST /api/jobs/:id/ops-task {task_type:'doi_lenh'}`** auto-assigns THIS WEEK's `doiLenhOpsId` via `getWeekRotation` (TP does not pick, L30); `ON CONFLICT (job_id,task_type) DO NOTHING`; the new doi_lenh gates completion.
- **`viec_khac`** = one-per-job, gates completion (`checkOpsTasksDone`, EXISTS-tolerant); `OPS_TASK_TYPES`/`OPS_DONE_TASK_TYPES` include it. "Việc khác" is the `ops_hp` service_type chosen at job creation — never added later (no "+ việc khác" button).
- **Retired:** `PATCH /:id/reassign-ops` (whole-job wipe destroyed per-task owners) + its frontend path + `reassignOps` client + dead `assignOps`. Kept: `suggestOps`+`getOpsContext` (null-rotation fallback + `waiting_ops` suggestions). Only `ReassignModal` CUS (job-level) remains.
- **Deferred:** dropping `ja.ops_id` entirely + flipping `/overview` ops branch to per-task; 3 historical tk-only jobs (#55/#61/#64) still carry a `doi_lenh` task.

**LCL rule (2026-06-24) — LCL shipments don't auto-get a `doi_lenh`:** an LCL (`jobs.cargo_type='lcl'`) HP shipment does NOT auto-create `doi_lenh` even when truck/both (same shape as the tk-only rule but gated on `cargo_type`). FCL keeps auto-getting it. TP adds one later via **"+ đổi lệnh"** (rotation-assigned). 4 sites (L31 lockstep): ① create-seeding (`&& cargo_type !== 'lcl'`); ② `reconcileJobSides` `dlDesired = newHP && truckDesired && !isLcl` (reads `cargo_type` fresh inside the helper); ③ "+ đổi lệnh" POST unchanged (manual escape hatch, no LCL exclusion); ④ `OpsTaskCell` "+ đổi lệnh" button shows for `service_type==='tk' OR cargo_type==='lcl'` (desktop+mobile, L26). On an LCL `both`, `primaryOpsOwner`/`resyncJaOpsPrimary` point `ja.ops_id` at the `thong_quan` owner (no doi_lenh person); only the `thong_quan` owner is notified. Completion gate unchanged (EXISTS-tolerant).

---

### Note — FCL container quantity matrix (CreateJobModal)
FCL container authoring in `CreateJobModal` uses a 6-cell **quantity matrix** (one number per `CONT_TYPES`: 20DC/40DC/40HC/45HC/20RF/40RF) + an auto-generated detail list (rows expose only `cont_number`+`seal_number`; the `cont_type` chip is read-only, follows the matrix — the source of truth for row count & type). `setQty(type,raw)`: increase → append empty rows of that type at the end of its group; decrease → drop from the end of the group (`window.confirm("Cont X sẽ bị xóa, tiếp tục?")` first if a dropped row has data); detail rows always ordered by `CONT_TYPES`. `selectCargoType()` FCL↔LCL reset clears both `contQty` + `containers`.
**Submit validation:** `Hàng nhập` → every detail row MUST have both `cont_number` AND `seal_number` (error `"Hàng nhập phải nhập đủ số cont và seal cho tất cả container"`); `Hàng xuất` → row-level fields optional (arrive later from carrier); zero rows permitted (backend inserts zero `job_containers`).
**Backend contract unchanged:** `POST /api/jobs` still reads `containers` as `Array<{cont_type,cont_number,seal_number}>` and skips rows with empty `cont_type` — only the in-modal authoring UX changed. **Out of scope:** `JobDetailModal` edit UI still uses the old per-row `cont_type` dropdown + manual add/remove (if adopting the matrix there, copy `contQty`+`setQty` and reset from `job.containers` group-by-type counts in `buildDraft`).

### Note — Sales "Quản lý công việc" tab (revenue-tick handoff)
3rd tab on `/my-dashboard`. Tracks LOG-completed jobs through revenue-recognition so Sales has a visible queue for Accounting. **The revenue amount is NOT entered in this app** (external accounting software) — the in-app tick is just a flag (`revenue_entered_at` timestamp + `revenue_entered_by`).
**Schema:** `jobs.revenue_entered_at TIMESTAMPTZ NULL` + `revenue_entered_by INTEGER NULL FK users(id) ON DELETE SET NULL` + `idx_jobs_revenue_status` partial composite `(sales_id, completed_at, revenue_entered_at) WHERE deleted_at IS NULL`.
**Sub-tab queries** (all scope by `j.sales_id = current_user.id`, L22): 🔵 Job pending (`pending`, `status='pending'`, `created_at DESC`) · 🟡 Yêu cầu nhập thu (`revenue_pending`, `status='completed' AND revenue_entered_at IS NULL`, `completed_at ASC` FIFO) · 🟢 Đã nhập thu (`revenue_entered`, `revenue_entered_at IS NOT NULL` + date filter on `completed_at`, default last 7d, `revenue_entered_at DESC`).
**Endpoints:** `PATCH /api/jobs/:id/revenue-tick` (sales-only, own, completed, not yet ticked) sets `revenue_entered_at=NOW(), revenue_entered_by=$user` + `recordHistory`; `DELETE` (same guards, currently ticked, **no time limit**) flips back to NULL + `recordHistory`. Both RETURNING the bare `jobs.*`; frontend invalidates `['jobs']`. Header stat card #7 reads a separate `['jobs','revenue_pending','count_only']` query (30s poll, `enabled: role==='sales'`); urgency muted@0 / amber@1-5 / red@>5; click jumps to the queue. Mobile: `SalesCard` + 3 `renderMobileCard` variants (L26).
**Rules:** revenue-tick is Sales-only (don't add LOG write paths; expose read-only to `lead`/future ACCOUNTING if needed) · don't store amounts (→ new `job_revenue` child table if ever required) · un-tick has NO time limit (don't add a cap) · audit lives in `job_history` under `field_name='revenue_entered_at'` (no parallel table) · TP/lead can hit `?tab=revenue_pending` without a `sales_id` filter for an all-sales view (the L22 Sales guard only applies to `role='sales'`).

### L15 — Invoice info on `customer_pipeline` (snapshot semantics, preserve-on-conflict)
Invoice data (full legal name, tax code, invoice address) lives on `customer_pipeline` (one row per `(sales_id, lowered company_name)`, L14) — not duplicated onto `jobs` or scattered across `customers`.
**Schema** (idempotent ALTER): `company_full_name VARCHAR(300) DEFAULT ''` (legal name) · `invoice_address TEXT DEFAULT ''` · `tax_code VARCHAR(30) DEFAULT ''` (MST — distinct from `customers.tax_code` and `jobs.customer_tax_code`; 3 separate columns).
**Form** (`CreateJobModal`): 3 inputs, "Khách mới" mode only, all required (submit guard `"Vui lòng nhập đủ thông tin xuất hóa đơn"`). Existing-customer mode auto-fills from `customer-search`.
**Backend** (`POST /api/jobs`): destructure adds `company_full_name`/`invoice_address`/`invoice_tax_code` (JS var name; DB column is `tax_code`); INSERT writes all 3; `ON CONFLICT (sales_id, LOWER(company_name)) DO UPDATE SET stage='booked', updated_at=NOW()` — the 3 invoice columns are NOT in the SET clause (preserved). `customer-search` SELECT exposes `cp.company_full_name`, `cp.invoice_address`, `cp.tax_code AS pipeline_tax_code`.
**BBBG** (`bbbg-data` + `POST /:id/bbbg-pdf` + `BBBGModal`): bbbg-data `LEFT JOIN LATERAL customer_pipeline` on `LOWER(company_name)=LOWER(j.customer_name)` (highest id) → `invoice_company_name`/`invoice_tax_code`/`invoice_address`. Modal pre-fills, ĐĐ can override per-PDF; `save_as_default` checkbox → backend `UPDATE customer_pipeline SET ... WHERE LOWER(company_name)=LOWER($4)` across ALL matching pipeline rows (before the PDF stream, try/catch, non-blocking). PDF inserts a "Thông tin xuất hóa đơn / (Invoice information)" section, omitted entirely when all 3 fields are empty after `.trim()`.
**Rules:** 3 invoice fields on `customer_pipeline` only · ON CONFLICT must NOT touch them · aliases: JS `invoice_tax_code` ↔ DB `customer_pipeline.tax_code` ↔ response `pipeline_tax_code` (don't conflate with `jobs.customer_tax_code`/`customers.tax_code`) · on transfer (L14) the new INSERT writes whatever the form supplied (pre-filled survives). (A prior `short_name` column was dropped — `company_name` is the internal short name; don't re-add without a new use case.)

### L14 — Customer pipeline ownership transfers on job creation
Customers belong to a specific `sales_id` via `customer_pipeline.sales_id`, not "the company". When TP/lead/DD creates a job for an existing customer under a different sales user, ownership must transfer cleanly (else the old pipeline stays + a duplicate row splits the customer).
**Behavior** (`routes/jobs.js` POST after the job INSERT):
1. If `sales_id && customer_name` present, find pipelines owned by other sales for the same customer (`LOWER(company_name)` OR `customer_id`).
2. Each: `DELETE FROM customers WHERE pipeline_id=X` (manual — FK is `ON DELETE SET NULL`; we want hard-delete so old sales loses interaction history), then `DELETE FROM customer_pipeline WHERE id=X` (cascades clear `pipeline_history` + `pipeline_delete_requests`).
3. UPSERT for the chosen sales: `INSERT ... ON CONFLICT (sales_id, LOWER(company_name)) DO UPDATE SET stage='booked'` with `RETURNING id, (xmax=0) AS was_inserted` (the `xmax=0` trick = insert-vs-update).
4. Notify: old sales `pipeline_transferred_out`; new sales `pipeline_transferred_in` (transfer) OR `pipeline_added` (fresh).
5. Audit on the JOB: `recordHistory(job_id, 'pipeline_transferred', oldSalesNames, newSalesName)`.
**Frontend** (`CreateJobModal`): when `selectedCustomer.sales_id !== form.sales_id`, confirm dialog before submit; the sales dropdown is editable so any creator can trigger transfer.
**Rules:** the sales user is the *owner*, not the company (never query "all pipelines for company X" without `sales_id`) · `(sales_id, LOWER(company_name))` UNIQUE is canonical; the pre-transfer DELETE uses name-OR-FK match · `xmax=0` on RETURNING detects insert-vs-update without a second query · the manual `DELETE FROM customers WHERE pipeline_id=X` is required (FK is SET NULL); don't change it to CASCADE.

### L13 — Snapshot pattern for FKs to user-managed reference tables
Pointing rows at a reference table via FK-only breaks on renames (past documents retroactively change) and hard-deletes (referential closure lost even with SET NULL).
**Pattern** (`transport_companies`): keep BOTH the FK and a denormalized `*_name` snapshot column; write both on select/update; on read prefer the JOIN'd current name when FK is non-null (renames flow through), fall back to the snapshot when FK is null (legacy/post-delete rows still render).
```sql
ALTER TABLE job_truck ADD COLUMN transport_company_id INTEGER REFERENCES transport_companies(id) ON DELETE SET NULL;
-- read: tc_name (current) ?? transport_name (snapshot)
```
**Rules:** adding an FK to a user-managed naming table → keep a `*_name` snapshot, write both · prefer `ON DELETE SET NULL` over CASCADE (snapshot is the historical record) · add a `LOWER(name)` UNIQUE INDEX (VARCHAR UNIQUE is case-sensitive) · optionally mark "legacy" in UI when FK is null. Future: `ports`, `vendors`, `forwarders`, `customs_brokers`.

### L12 — Debug with real data before fixing, and beware of default values
Data-display bugs trigger assumption-based fixes that miss the real data shape; schema `DEFAULT` values leak into queries (e.g. `cus_confirm_status DEFAULT 'pending'` made truck-only jobs without `cus_id` match CUS pending queries). ("CUS chưa nhận = 0" took 3 iterations — the counts were correct all along.)
**Rules:**
1. **Debug with real data first:** run a `SELECT` on the actual DB before writing fix code; report results; confirm the "bug" is actually wrong behavior, not correct behavior on empty data.
2. **Watch DEFAULT values:** any row created without a column gets its DEFAULT even when not semantically applicable — could it match queries it shouldn't? Common fix: explicit NULL guards (`AND cus_id IS NOT NULL`).
3. **Repeat bugs:** L12 applies with extra rigor; never skip the real-data step.

---

### Note — `checkAndCompleteJob` / `get_truck_booking_status` are shared code — run `codegraph_impact` before editing
See §9. Completion + booking-status logic touches many endpoints; a drive-by edit is the "fixed here, still broken there" bug class (L9/L10/L24).

### Note — PUT `/api/jobs/:id` field-level edit permissions (assigned-CUS widening, 2026-06-29)
Who may edit which sensitive job field via `PUT /api/jobs/:id` — computed INSIDE the transaction after the `job_assignments` lookup (so it can read `_ja[0].cus_id`). Backend authority = `services/job-access.js` (`canEditJob` / `canReassignOwnerOrStatus`).

| Field | Who may set it |
|-------|----------------|
| `sales_id` (ownership) | TP/lead **OR the assigned CUS** (`CUS_ROLES` member with `cus_id===user.id`). A genuine change to a non-null target is validated via `validateAssignee(client, id, ['sales','lead'], 'Sales')` (L32); unchanged/blank-unassign skip validation. (POST writes `sales_id` UNVALIDATED + L14 transfer; PUT is stricter because it's reachable by the wider assigned-CUS set.) |
| `deadline` | TP/lead **OR the assigned CUS**. DD/sales/KT blocked (403). |
| `status` | TP/lead ONLY (`canReassignOwnerOrStatus`) — system-computed; stripped from the editable whitelist for everyone else. DD completion (`body.completed_at`) is unaffected (writes `dd_completed_at`, not `status`). |

Editable whitelist `FIELDS` = `BASE_FIELDS` filtered by `_mayOwner` (sales_id) + `_isTpLead` (status). **Frontend mirror** (`JobDetailModal` edit form): `isAssignedCus = canEditTk && Number(job.cus_id)===Number(user.id)`; deadline + payload-send gated on `(isTP || isAssignedCus)`; status `<select>` gated on `(isTP || isLead)` (hidden for assigned-CUS/DD/sales/KT — was previously a misleading server-stripped no-op); `sales_id` dropdown renders for any editor. Single edit form, no mobile variant (L26).

### Note — `admin` role + user-management panel (2026-06-11)
`'admin'` = app-wide user administrator, above every dept, distinct from `truong_phong_log`. Only admins reach `/api/admin/*` (router-gated `requireAuth + requireAdmin`; `requireAdmin` in `middleware/auth.js` mirrors `requireKeToan`). Endpoints (`routes/admin.js`): list/create/edit/`:id/role`/`:id/disable`/`:id/enable`/`:id/reset-password`. Create + reset-password return a one-time temp password (bcrypt; never returns `password_hash`/gmail secrets). Self-lock + last-admin invariants in `services/admin-guards.js` (`isValidRole`/`isSelf`/`wouldRemoveLastAdmin`). UI: `AdminPage.jsx` (`/admin`, `ProtectedRoute roles={['admin']}`), Navbar 🛡️ "Quản trị" pill (admin only, desktop+mobile), auto-assign toggle reusing `/api/jobs/settings` (gate widened to `admin`).
**`users.disabled_at`** (soft-disable, NULL=active) enforced at BOTH `routes/auth.js` login AND `requireAuth` (7-day JWT → check every request). Operational propagation = L32.
**Bootstrap the first admin** (endpoints are admin-gated → set out-of-band): `railway ssh --service fwd-sales -- node /app/backend/src/db/make_admin.js <username>` (idempotent; clears `disabled_at`; durable across deploys after L33). Current first admin: `hai` (Mr Hải, id=15).

### Note — KT user `ketoan_cong_no` (id=2965)
`role='ke_toan'`. Username `ketoan_cong_no` (renamed from `ketoan_test` 2026-05-25). Name "Kế Toán Công Nợ". First real KT user; password reset to a known temporary (owner to rotate).

### Note — KT read-only view of the TP LOG dashboard (2026-07-02)
`ke_toan` gets a **strictly read-only** mirror of the TP LOG dashboard — both tabs, all jobs, view-only. **Reuses `LogDashboardTP` via a `readOnly` prop** (NOT a duplicate — L9/L10); the prop defaults false so the TP experience is byte-for-byte unchanged (every gate is `!readOnly && …` or `readOnly ? … : <original>`).
- **Routing** (`App.jsx`): `if (role === 'ke_toan') return <LogDashboardTP readOnly />`; `/log-dashboard` route opens to `roles={[...LOG_ROLES,'ke_toan']}` (shared `LOG_ROLES` untouched → `RootRedirect` still sends KT to `/accounting-dashboard`; KT reaches the LOG view only via the Navbar "📋 Công việc LOG" pill, `ke_toan`-only).
- **Every write control hidden when `readOnly`** (desktop+mobile, L26): Tạo Job, header stats + StaffSections + Overview (whole block), assignee filter, "Phân công" column, inline deadline (→ text), CUS reassign, the 3 OPS cells + "+ đổi lệnh" (`OpsTaskCell readOnly`), delete, "Đặt kế hoạch xe", all write modals. Kept: both tabs, full table, 🔍 → read-only `JobDetailModal`. `getJobStats`/`getJobSettings`/`getLogStaff` queries `enabled: !readOnly` (KT fires zero of them).
- **Server-side is the real guardrail:** `canViewJob` returns true for `ke_toan`; every mutation is `truong_phong_log`-gated or excludes `ke_toan` via `canEditJob`/`canEditJobTk`. The one gap — `POST /api/jobs` (create) had no role gate — is closed with a `ke_toan`→403 denylist.

### Note — KT "Đã xuất hóa đơn" invoice-issued marker (2026-07-02)
An **independent** invoice-issued flag on the KT công nợ workflow — tick + issue date + display. **NOT a pipeline stage:** doesn't gate/reorder `pending_check → checked → debit_sent → paid`, doesn't touch stats/KPIs. **Precondition = `accounting_checked_at IS NOT NULL` only** (issue before OR after the debit note). Double-issue rejected; **no un-tick**.
- **Schema** (KT1 block): `jobs.invoice_issued_at TIMESTAMPTZ` + `invoice_issued_by INTEGER REFERENCES users(id) ON DELETE SET NULL` (nullable, no partial index).
- **Backend** (`routes/accounting.js`, mirrors debit-sent): `PATCH /api/jobs/:id/invoice-issued` on `jobActionsRouter` (`requireAuth + requireKeToan` → non-KT 403). BEGIN → `fetchJobForKt` → 404 / 400 `"Job chưa được kiểm tra"` (no `accounting_checked_at`) / 400 `"Job đã xuất hóa đơn trước đó"` → `UPDATE invoice_issued_at = COALESCE($1::timestamptz, NOW()), invoice_issued_by=$2` → `recordHistory('invoice_issued_at', null, ts)` → COMMIT. `fetchJobForKt` + `GET /api/accounting/jobs` gained `invoice_issued_at`/`invoice_issued_by` + `invoice_issued_by_name`.
- **API:** `accountingInvoiceIssued(id, issuedAt)`.
- **Two placements:** (1) `JobDetailModal` 🧾 "Đã xuất HĐ" button in the KT action bar (gated `isKT && !editMode && accounting_checked_at && !invoice_issued_at && onInvoiceIssued`; only `AccountingDashboard` passes it). (2) `AccountingDashboard` `debit_sent` tab — a new "Đã xuất HĐ" column: issued → date; not → an **inline tick button in the cell** (date dialog, `invoiceMut`, without opening the job). Both paths reuse `invoiceMut` (invalidates `['accounting']`); desktop `cell()` + `debit_sent` mobile card (L26).

Independent marker — don't add to stats, don't gate the lifecycle, don't add a LOG/Sales write path. Un-tick/amount → a new endpoint / child table.

### Note — CUS overdue redefined by TK-completion (`tk_datetime`), 2026-07-03
**`jobs.deadline` = "TK phải xong trước giờ này".** Overdue no longer keys on raw `deadline` vs `NOW()` (a TK-done job kept showing red); it keys on `job_tk.tk_datetime` (the "Ngày TK" stamp), applied on **every screen** so numbers and colors always agree:

| State | Predicate | Visual |
|---|---|---|
| Sắp hạn (amber) | `tk_datetime IS NULL AND deadline ∈ [NOW, +24h] AND status='pending'` | amber — self-clears on TK entry |
| Chưa TQ, quá hạn (red) | `tk_datetime IS NULL AND deadline < NOW() AND status='pending'` | red — self-clears on TK entry |
| Quá hạn thật (fact) | `tk_datetime IS NOT NULL AND tk_datetime > j.deadline` — all-time, incl. completed (no status filter) | "Trễ" badge |
| clean | `tk_datetime <= deadline`, or missing `job_tk` row, or `deadline` NULL | none |

**Deadline coloring is gated on `!tk_datetime`** at every call site (the per-file `deadlineStyle` helper stays untouched, L30) — a TK-done job never shows amber/red; a TK-done-after-deadline job shows a red "Trễ" badge instead. `han_lenh` coloring (L19) is a separate field, unchanged.
**One definition, every surface** (commit `a44cede`): CUS dashboard (3 cards Sắp hạn 24h / Chưa TQ quá hạn / Quá hạn thật `qua_han_that` → drilldowns `cus_near_deadline`/`cus_overdue`/`cus_true_overdue`; row tint + cell gated + `LateBadge`) · TP per-CUS stats (`queryCusStaffStats` `CUS_COLS` new `qua_han_that` + tk-gated `overdue`/`near_deadline` → equals what the CUS sees; drilldowns `staff_cus_*`) · TP global `overdue`/`warn_soon` cards + drilldowns gated on `tk_datetime IS NULL` (truck-only/`ops_hp` have no `job_tk` → unaffected) · TP + KT-readonly deadline coloring (`InlineDeadline` `tkDone`/`isLate`) · `JobListModal` drilldowns (tk-aware cell + `statusPredicate` relaxing `status='pending'`→`TRUE` for the all-time `*_true_overdue` filters).
**App-code only, no schema change** (`tk_datetime` already exists + is in every relevant SELECT). When adding any new deadline surface, reuse this definition — never re-introduce raw `deadline < NOW()` without the `tk_datetime` gate. (DD signals `dd_sap_han`/`dd_kh_qua_han`/`canh_bao_chua_van_tai` referenced here were removed by the DD-overdue redesign below.)

### Note — DD overdue redefined as 3 per-leg content-based tiers (2026-07-05)
The DD dashboard's 3 old mixed overdue signals (deadline-48h / han_lenh-24h / per-container booking date) are replaced by one **content-based, per-delivery-leg** 3-tier definition. A "leg" = a `truck_bookings` row (FCL = per-container leg via `truck_booking_containers`; **LCL = whole-lot leg, no container link — tracked identically to FCL**). Commit `fc1104a`. **ONE definition, three consumers** — module-level SQL fragments in `routes/jobs.js` ~L50-105, shared by the DD `/stats` cards + `/filtered` drilldowns + `GET /` row flags (L5/L30):

| Tier | stat key | Definition (per leg; `COUNT(DISTINCT j.id)` for the card) |
|---|---|---|
| T1 Quá hạn đặt KH xe | `dd_qh_dat_kh` | `han_lenh < NOW()` AND a leg is **unplanned** — FCL: ≥1 container with no live booking link; LCL: job has ZERO live `truck_bookings`. Partial planning still flags. |
| T2 Quá hạn giao hàng | `dd_qh_giao` | ∃ leg with `planned_datetime < NOW() AND transport_company_id IS NULL` (no carrier). |
| T3 Quá hạn nhập thu | `dd_qh_nhap_thu` | ∃ leg with `NOW() > planned_datetime + INTERVAL '5 days' AND actual_datetime IS NULL` (`T3_OVERDUE_DAYS=5`). |

**"Trễ" fact badge** (separate): a leg delivered late — `actual_datetime > planned_datetime` (`dd_tre_giao`).
**Exclusions (all tiers unless noted):** cancelled legs (`tb.deleted_at IS NULL`); completed jobs (`j.dd_completed_at IS NULL`, L25); no-truck-side (`service_type IN ('truck','both')`); **T1 only** also excludes a `'both'` job still awaiting CUS (`DD_T1_CUS_GATE = service_type='truck' OR job_tk.completed_at IS NOT NULL`). **LCL is NOT excluded** — T2/T3/"Trễ" are leg-anchored (cover FCL+LCL); only T1's "unplanned" branches by `cargo_type` (FCL branch byte-identical to prior). LCL delivery = container-less whole-lot booking via the bulk "Đặt kế hoạch xe" endpoint (`truck-bookings.js`: FCL requires `container_id`, LCL forbids it).
**Frontend** (`LogDashboardDieuDo.jsx`): old 3 rows → new "Cảnh báo quá hạn" card (T1/T2/T3, click → drilldown). Kept: Card 1 workload, Card 2 forward day-buckets, Card 3 "Chưa đổi lệnh"/"Chưa hoàn thành". Row tint + han_lenh cell (red for T1) + "Trễ" badge from backend `dd_qh_*`/`dd_tre_giao` row flags (computed in `GET /` only for `role='dieu_do'`); old `deadlineStyle(han_lenh)` time coloring removed. Desktop+mobile parity (L26). Drilldown labels in `JobListModal`.
**No schema change** (all fields already exist). **TP does NOT aggregate DD overdue** — TP's per-DD stats (`queryDieuDoStaffStats` → `DD_COLS`: `urgent_no_truck`/`overdue_delivery`/`cham_cost`) are a separate signal set, untouched. When adding a new DD delivery-overdue surface, reuse these leg-anchored fragments — never a container-only or deadline-based signal.

### Note — SLB company identity on outgoing documents (2026-07-08)
SLB's own legal info on outgoing documents. **Name + MST are stable; only the address changed** (Diamond Building/Lê Hồng Phong → Tasa/Đông Hải):
- **Tên:** `CÔNG TY TNHH TIẾP VẬN TOÀN CẦU SLB` / `SLB GLOBAL LOGISTICS COMPANY LIMITED` · `SLB GLOBAL LOGISTICS CO., LTD.`
- **MST:** `0201743661` · **Tel** `+84 931 334 331` · **Email** `info@slbglobal.com` · **Web** `www.slbglobal.com` (unchanged).
- **Địa chỉ VN:** `Số 18/100 Khu dân cư Tasa, Phường Đông Hải, Thành phố Hải Phòng, Việt Nam`.
- **Địa chỉ EN:** `No 18/100 Tasa Residential Area, Dong Hai Ward, Hai Phong City, Viet Nam`.

**The address is NOT single-sourced — 6 edit points:** (1-2) canonical constants `SLB_INVOICE_INFO` (VN) + `SLB_INVOICE_INFO_EN` (EN) in `backend/src/services/email-sender.js` — feed the email invoice block/footer/signature (`type==='slb'`), cancel-mail defaults, the BBBG override (`bbbg-pdf.js` imports `SLB_INVOICE_INFO_EN`), and `GET /api/email/slb-invoice-info`; (3-5) letterhead literals hardcoded inline (NOT from the constant) — `bbbg-pdf.js` single-BBBG (~:91) + multi-booking (~:377) headers, `sea-quote-pdf.js` header (~:127); (6) frontend `InvoiceRecipientModal.jsx` local `SLB` const (~:26).
**Rule:** if SLB's address/name/MST changes again, edit **all 6** (grep `Tasa Residential Area` / `Khu dân cư Tasa`). Brand-only surfaces (Login/Navbar/index.html/manifest — name only, no legal info) are intentionally excluded; `routes/accounting.js` generates no document.

---

## 6. Session Start Checklist

1. Read this file.
2. Read `frontend/src/CLAUDE.md` and/or `backend/CLAUDE.md` for your area.
3. `git status` and `git log --oneline -10`.
4. Read the specific file you're about to change — don't modify what you haven't read.

---

## 7. Deployment

> **Railway GitHub auto-deploy is NOT active** (Settings → Source: "Auto deploy unavailable"). Every commit needs an explicit `railway up --detach`. Full rationale + verification in **L18**.

**The atomic post-commit checklist — all 6 steps, no skipping:**
1. `git add <changed files>` — stage only relevant files (never `git add -A`).
2. `git commit -m "<descriptive message>"`
3. `git push origin master`
4. `railway up --detach` ← **MUST DO, DO NOT SKIP** (else production stays on the old bundle).
5. **Verify with curl** — probe a route/string unique to this commit: new route → `curl -sw "%{http_code}\n" .../api/<new-route>` expect 401 (not 200+HTML = missing); frontend-only → confirm `assets/index-<hash>.js` changed; backend logic → drive it end-to-end or check `railway logs --build` for a fresh image.
6. **Report actual verified status** (bundle hash / image timestamp / feature check) — never "should be live now".

```bash
git add <changed files>
git commit -m "<descriptive message>"
git push origin master
railway up --detach   # MUST DO
curl -s -o /dev/null -w "%{http_code}\n" https://fwd-sales-production.up.railway.app/api/<probe>
```

`start.js` on the new container runs in order: `schema.sql` migrations → `backfill_pipeline.js` → `npm run build` (frontend) → Express server. Idempotent — safe every deploy.

---

## 8. ECC Usage (Everything Claude Code)

- **Before a new feature/module:** `/plan` for a blueprint; **architect** agent for new schemas; **database-reviewer** agent before migration.
- **After a feature:** `/code-review` (**typescript-reviewer** + **code-reviewer**); `/security-scan` before a major deploy; `/update-docs`; `/learn`.
- **Skills to load when needed:** `postgres-patterns` (complex queries), `api-design` (new endpoints), `database-migrations` (schema), `backend-patterns` (new routes), `cost-aware-llm-pipeline` (AI features, Phase 2+), `continuous-learning-v2`.
- **Agents:** planner, architect, database-reviewer, typescript-reviewer, code-reviewer, build-error-resolver, security-reviewer, doc-updater, refactor-cleaner.
- **Token hygiene:** keep <10 MCPs enabled; `/compact` at breakpoints; `/clear` between unrelated tasks; `/learn` at the end of a major session.

---

## 9. CodeGraph (code navigation)

Project has a live `.codegraph/` index. For code exploration ("how does X work", "where is Y", "what calls Z"), prefer CodeGraph MCP over grep/glob/read: `codegraph_search` (find by concept) · `codegraph_callers`/`codegraph_callees` · `codegraph_context` · `codegraph_impact` (**what breaks if I change this**).

**Bắt buộc chạy `codegraph_impact` TRƯỚC khi sửa shared code**, đặc biệt:
- `backend/src/db/schema.sql` (DDL dùng chung)
- `checkAndCompleteJob` (`job-completion.js`) — completion logic chạm nhiều endpoint (L24)
- `get_truck_booking_status` (plpgsql) — truck completion, FCL + LCL (L20/L25)
- status / role / service_type / cargo_type enums + their guards
- shared modals (JobDetailModal, PlanDeliveryModal, TruckPlanningModal) + shared dashboards

Lý do: nhiều bug gần đây là "sửa chỗ này quên chỗ kia" — TK trigger gap, cost gate ảnh hưởng cả 'tk'+'both', LCL phải fix ở 2 modal. `codegraph_impact` bắt các điểm ảnh hưởng trước khi sửa.
