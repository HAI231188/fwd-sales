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
