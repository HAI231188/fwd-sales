# CLAUDE.md — SLB Global Logistics Internal Management System

> **READ THIS FILE FIRST at the start of every session.**
> Follow all conventions here. Check existing patterns before adding new code.
> When in doubt about naming, structure, or logic — look at existing files first.

---

## 1. Project Vision

**SLB Global Logistics** is building an internal management system starting with the **Sales team**, then expanding to other departments. The goal is one unified platform replacing spreadsheets and manual reporting.

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
│   ├── start.js          # Production entry: runs migrate → backfill → build frontend → start
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
| NOTIFICATION | (not yet built) | Future: overdue follow-up alerts, booking confirmations |

### Future modules (do not build yet — plan carefully before touching)

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

## 4. Naming Conventions

### Files
- React components: `PascalCase.jsx` (e.g., `CustomerDetailModal.jsx`)
- Pages: `PascalCase.jsx` in `src/pages/`
- Backend routes: `snake_case.js` (e.g., `pipeline.js`)
- DB scripts: `snake_case.js` (e.g., `backfill_pipeline.js`)

### Functions and variables
- React components: `PascalCase`
- Hooks: `camelCase` starting with `use` (e.g., `useAuth`)
- Event handlers: `handle` prefix or `on` prefix passed as props (e.g., `handleSave`, `onClose`)
- Mutation functions: named after the action (e.g., `completeMutation`, `undoMutation`)
- Backend route handlers: inline async `(req, res) =>` — no named functions
- DB query helpers: descriptive camelCase (e.g., `applyAutoTransitions`)

### API endpoints
- Pattern: `/api/<resource>/<id>/<sub-resource>`
- Collections: plural noun — `/api/customers`, `/api/reports`
- Nested actions: `/api/pipeline/customers/:id/updates`
- Special actions: use verb suffix — `/api/reports/quick-customer`, `/api/pipeline/customers/updates/:id/complete`
- Query params for filtering: `startDate`, `endDate`, `userId`, `search`, `limit`

### Database tables and columns
- Tables: `snake_case` plural (e.g., `customers`, `customer_pipeline`, `pipeline_history`)
- Columns: `snake_case` (e.g., `company_name`, `follow_up_date`, `created_at`)
- FK columns: `<table_singular>_id` (e.g., `report_id`, `user_id`, `pipeline_id`)
- Boolean flags: descriptive positive names (e.g., `follow_up_completed`, `closing_soon`, `decision_maker`)
- Timestamps: always `created_at` and `updated_at` (WITH TIME ZONE)
- Audit columns: `created_by` referencing `users(id)` ON DELETE SET NULL

---

## 5. Design System

### CSS Variables (defined in `frontend/src/index.css`)

```css
--bg             /* page background: #f8f9fa */
--bg-card        /* card surface: #ffffff */
--bg-card-hover  /* card hover: #f1f5f9 */
--bg-input       /* input background: #ffffff */
--primary        /* brand green: #22c55e */
--primary-dim    /* green at 10% opacity */
--primary-glow   /* green at 25% opacity */
--border         /* default border: #e5e7eb */
--border-active  /* focused border: #22c55e */
--text           /* primary text: #1f2937 */
--text-2         /* secondary text: #6b7280 */
--text-3         /* tertiary/placeholder: #9ca3af */
--danger         /* red: #ef4444 */
--danger-dim     /* red at 10% opacity */
--warning        /* amber: #d97706 */
--warning-dim    /* amber at 10% opacity */
--success        /* same as --primary: #22c55e */
--info           /* blue: #3b82f6 */
--info-dim       /* blue at 10% opacity */
--purple         /* #7c3aed */
--purple-dim     /* purple at 10% opacity */
--radius         /* 12px — card corners */
--radius-sm      /* 8px — input/button corners */
--shadow         /* card shadow with border ring */
--shadow-card    /* lighter card shadow */
--font           /* 'DM Sans', sans-serif — body */
--font-display   /* 'Space Grotesk', sans-serif — headings */
--transition     /* 0.2s ease */
```

### Utility classes (from `index.css`)
- `.card` — white card with border, radius, shadow
- `.btn` — base button (inline-flex, gap 8px, padding 10px 20px)
- `.btn-primary` — green filled button
- `.btn-ghost` — transparent with border
- `.btn-danger` — red tinted button
- `.btn-sm` — smaller padding/font
- `.btn-icon` — square icon button
- `.input` — base input style
- `.form-group`, `.form-label`, `.form-input`, `.form-select`, `.form-textarea`
- `.page`, `.container` (max 1200px, auto margins)

### Component patterns
- **Inline styles for layout/positioning**, CSS classes for reusable appearance
- **Modals**: fixed overlay with `z-index: 1000`, white card centered, `onClose` on overlay click
- **Toast notifications**: `react-hot-toast` — `toast.success()`, `toast.error()`
- **Loading states**: simple `isLoading` check, return `null` or spinner
- **Empty states**: inline message inside the card/section, not a separate component
- **Mutations**: always use `useMutation` + `useQueryClient` → `invalidateQueries` on success
- **Forms**: controlled components, `useState` for each field, submit calls API function from `api/index.js`
- **Avatar**: colored circle with user initial, color from `u.avatar_color` (hex stored in DB)

---

## 6. Database Schema

### Core tables

**`users`** — system accounts
```
id, name, code (short 2-3 char code), role ('sales'|'lead'),
avatar_color (hex), username, password_hash, created_at
```

**`reports`** — daily sales activity reports (one per user per date)
```
id, user_id, report_date, total_contacts, new_customers, issues, created_at, updated_at
UNIQUE(user_id, report_date)
```

**`customers`** — individual customer interactions logged in a report
```
id, report_id, user_id, company_name, contact_person, phone,
source ('cold_call'|'zalo_facebook'|'referral'|'email'|'direct'|'other'),
industry, interaction_type ('saved'|'contacted'|'quoted'),
needs, notes, next_action, follow_up_date,
potential_level ('high'|'medium'|'low'), decision_maker (bool),
preferred_contact, estimated_value, competitor,
address, tax_code, customer_code (format: 0001120426 = seq+ddmmyy),
pipeline_id (FK → customer_pipeline),
follow_up_completed (bool), follow_up_result (text),
created_at, updated_at
```

**`quotes`** — freight quotes attached to a customer interaction
```
id, customer_id, cargo_name, monthly_volume_cbm, monthly_volume_kg,
monthly_volume_containers, route, cargo_ready_date,
mode ('sea'|'air'|'road'), carrier, transit_time,
price (JSON array of {carrier, price, cost} options, stored as TEXT),
status ('quoting'|'follow_up'|'booked'|'lost'),
follow_up_notes, lost_reason, closing_soon (bool),
created_at, updated_at
```

### Pipeline tables

**`customer_pipeline`** — one row per (sales_id, company_name) — persists across reports
```
id, customer_id (FK, nullable), sales_id, company_name, contact_person,
phone, industry, source,
stage ('new'|'dormant'|'following'|'booked'),
last_activity_date, created_at, updated_at
UNIQUE INDEX on (sales_id, LOWER(company_name))
```

**`pipeline_history`** — audit trail of stage transitions
```
id, pipeline_id, from_stage, to_stage, changed_at, changed_by
```

**`customer_interaction_updates`** — threaded notes under a customer interaction
```
id, customer_id, note (TEXT), follow_up_date,
completed (bool), completion_note (text),
created_at, created_by
```

### Utility tables

**`customer_code_seq`** — daily sequence counter for customer_code generation
```
seq_date (DATE PK), last_seq (INTEGER)
```

---

## 7. API Conventions

### Authentication
- All routes use `requireAuth` middleware (JWT Bearer token)
- Token stored in `localStorage` as `fwd_token`
- User stored in `localStorage` as `fwd_user` (JSON)
- Sales users only see their own data; `lead` role sees all, can filter by `userId`

### Response format
- Success: return the data directly (array or object) — no envelope wrapper
- Created: `res.status(201).json(record)` — return the full created record
- Error: `res.status(4xx/5xx).json({ error: 'message' })`
- Not found: `res.status(404).json({ error: 'Không tìm thấy' })`
- Forbidden: `res.status(403).json({ error: 'Không có quyền' })`

### Database access
- Simple queries: `db.query(sql, params)` — returns `{ rows, rowCount }`
- Transactions: `const client = await db.pool.connect()` → `BEGIN/COMMIT/ROLLBACK` → `client.release()`
- Always use `RETURNING *` after INSERT/UPDATE to get the full record back
- Parameterized queries only — never string interpolation for user input
  - Exception: date strings from trusted `req.query` are sanitized with `.replace(/'/g, '')`

### Frontend API module (`frontend/src/api/index.js`)
- One named export per endpoint
- Naming: verb + noun (e.g., `getCustomers`, `updateQuote`, `markUpdateComplete`)
- All functions return the axios promise (response interceptor unwraps `.data`)
- Add new exports here — never call axios directly from components
- Active customer exports: `getCustomers`, `updateCustomer` — the old `createCustomer`, `getCustomer`, `deleteCustomer` were removed (superseded by `quickAddCustomer`)

---

## 8. Business Logic Rules

### Pipeline stages
| Stage | Meaning | Auto-transition trigger |
|-------|---------|------------------------|
| `new` | First contact, no real engagement yet | → `following` when any interaction is `contacted` or `quoted` |
| `following` | Actively being followed up | → `dormant` after 7 days of no activity |
| `dormant` | Gone cold | Manual only (or reactivated by new interaction) |
| `booked` | Won — has a booked quote | Manual only |

Auto-transitions run lazily on `GET /api/pipeline` via `applyAutoTransitions()`.

### Report metadata editing
- `ReportDetail.jsx` has an inline edit form (toggled by "✏️ Chỉnh sửa") for `total_contacts`, `new_customers`, and `issues`
- Only visible to the report owner (`report.user_id === user.id`)
- Calls `PUT /api/reports/:id` via `updateReport`
- Reports are auto-created by `POST /api/reports/quick-customer` — manual creation via a form no longer exists

### Customer code generation
- Format: `[4-digit daily sequence][DDMMYY]` → e.g., `0001130426`
- Only generated when a **new company** is first added to the pipeline
- Uses `customer_code_seq` table with `INSERT ... ON CONFLICT DO UPDATE` for atomic increment
- Subsequent interactions with the same company get `NULL` customer_code
- Frontend finds the code with: `interactions.find(i => i.customer_code)?.customer_code`

### KPI / Dashboard stats
- **Total contacts**: COUNT of customer rows in reports (within date range)
- **New customers**: SUM of `reports.new_customers` field
- **Total quotes**: COUNT of quote rows linked to customers in reports
- **Booked**: COUNT of quotes with `status='booked'`
- **Follow up**: COUNT of quotes with `status='follow_up'`
- **Closing soon**: COUNT of quotes with `closing_soon=TRUE` and status not booked/lost
- **CHO FOLLOW (waiting follow-up)**: COUNT of customers where:
  - `follow_up_date <= CURRENT_DATE`
  - `interaction_type != 'saved'`
  - `follow_up_completed = FALSE`
  - AND no completed `customer_interaction_updates` row exists as the "latest" update (using NOT EXISTS correlated subquery)

### Follow-up completion logic
- **Customer-level**: `customers.follow_up_completed` + `customers.follow_up_result`
  - Set via `PATCH /api/pipeline/customers/:id/follow-up-complete`
- **Update-level**: `customer_interaction_updates.completed` + `completion_note`
  - Set via `PATCH /api/pipeline/customers/updates/:id/complete`
  - Undone via `PATCH /api/pipeline/customers/updates/:id/uncomplete`
- "Latest" completed check: a completed update is considered resolved only if no newer uncompleted update exists after it

### Quote price field
- Stored as JSON array string: `[{carrier, price, cost}, ...]`
- Up to 5 options per quote
- Parsed with `parseOptions(price, carrier)` in `CustomerDetailModal.jsx`

### Roles
- `sales`: can only see/edit their own data
- `lead`: sees all data, can filter by `userId`; cannot be filtered to a single user's view in per-sales breakdown
- `lead` can edit any customer via `PUT /api/customers/:id` (no `user_id` restriction) and any pipeline entry via `PUT /api/pipeline/:id/info`

### Customer search (`GET /api/customers`)
- `search` param: ILIKE match on `company_name` and `contact_person` — includes all interaction types including `saved`
- `excludeSaved=true` param: explicitly filters to `contacted` and `quoted` only (used by dropdowns that should not surface saved-only contacts)

---

## 9. Golden Rules

1. **Never hard-delete customer or report data.** If deletion is needed in the future, add a `deleted_at` column (soft delete). The current `DELETE` endpoints on customers are the only exception and should be reviewed before expanding.

2. **Always maintain an audit trail.** Stage changes → `pipeline_history`. Interaction updates have `created_by`. Future: extend this pattern to all sensitive mutations.

3. **Schema changes must be idempotent.** All DDL goes in `schema.sql` using `IF NOT EXISTS` and `ADD COLUMN IF NOT EXISTS`. Never write one-off migration scripts that can't be re-run safely.

4. **Transactions for multi-table writes.** Any mutation that touches more than one table must use a `BEGIN/COMMIT/ROLLBACK` transaction block with `client.release()` in finally.

5. **Mobile-first UI.** Modals and cards must be usable on a phone screen. Use `flexWrap`, relative widths, and readable font sizes. Test modal layouts at 375px width mentally before shipping.

6. **Vietnamese UI text, English code.** All button labels, toast messages, section headers, and placeholder text are in Vietnamese. All variable names, function names, column names, and comments are in English.

7. **State lifting for stable React state.** If a child component's state resets unexpectedly due to re-renders from React Query invalidations, lift the state to the nearest stable parent and pass it as props. (See `FollowUpWidget` / `UpdateRow` / `InteractionFollowUpWidget` pattern.)

8. **No speculative features.** Only build what the user explicitly asks for. Do not add extra config options, error cases that can't happen, or UI elements not requested.

---

## 10. Instructions for Claude Code

### At the start of every session
1. Read this file (`CLAUDE.md`) completely.
2. Check the current git status: `git status` and recent commits: `git log --oneline -10`.
3. If working on a specific component or route, read it in full before suggesting changes.

### Before adding any new feature
- Search for existing patterns first (e.g., if adding a new modal, read an existing modal).
- Check `frontend/src/api/index.js` to see if the API call already exists.
- Check `backend/src/routes/` to see if the endpoint already exists.
- Check `schema.sql` before adding any new columns or tables.

### Code style rules
- Backend: CommonJS (`require`/`module.exports`), no TypeScript, no ORM — raw SQL only.
- Frontend: ES modules, functional components, hooks only (no class components).
- CSS: inline styles for one-off layout, CSS classes (from `index.css`) for reusable appearance. No CSS modules, no Tailwind.
- No console.log in frontend production code. Backend can keep diagnostic logs.
- Do not add PropTypes, JSDoc, or TypeScript annotations unless the file already has them.

### Deployment workflow
- After code changes: `git add <specific files> && git commit -m "..."` then `railway up --detach`.
- The Railway deploy runs `start.js` which: runs migrations → backfills pipeline → builds frontend → starts server.
- Never skip migrations or assume the DB is already up to date.

### When the user says "push and redeploy"
Run in sequence:
```bash
git add <changed files>
git commit -m "<descriptive message>"
git push origin master
railway up --detach
```
