# Frontend — Component & UI Guide

> Read `../../CLAUDE.md` first for architecture, modules, and golden rules.

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

React 18 + Vite. ES modules throughout. No TypeScript, no CSS modules, no Tailwind.
All API calls go through `api/index.js` — never import axios directly in components.

---

## Design tokens (`index.css`)

Always use these variables — never hardcode colours except when a specific hex is required for a one-off badge or section header that doesn't map to a token.

```
--primary        #22c55e   brand green
--danger         #ef4444   red
--warning        #d97706   amber
--info           #3b82f6   blue
--purple         #7c3aed

--text           #1f2937   body text
--text-2         #6b7280   secondary
--text-3         #9ca3af   placeholder / tertiary

--bg             #f8f9fa   page background
--bg-card        #ffffff   card surface
--border         #e5e7eb
--radius         12px      card corners
--radius-sm      8px       inputs / buttons
--font           'DM Sans', sans-serif
--font-display   'Space Grotesk', sans-serif
```

Each colour also has a `-dim` variant (10% opacity) and `--primary` has `--primary-glow` (25%).

## Utility classes

```
.card               white card: border + radius + shadow
.btn                base button
.btn-primary        green fill
.btn-ghost          transparent + border
.btn-danger         red tinted
.btn-sm  .btn-icon  size variants
.form-group  .form-label  .form-input  .form-select  .form-textarea
.page  .container   (container = max 1200px, auto margins)
.grid-2  .grid-6    CSS grid helpers
.badge  .badge-primary  .badge-warning  .badge-danger
.tabs  .tab  .tab.active
.spinner  .empty-state  .loading-screen
```

**Rule:** inline styles for one-off layout/positioning; CSS classes for any appearance that already has a class. Never add new CSS files.

---

## Component map

| File | Purpose |
|------|---------|
| `App.jsx` | Router, `AuthContext`, `ProtectedRoute` |
| `api/index.js` | All axios calls — one named export per endpoint |
| `pages/SalesDashboard.jsx` | role=sales: stat cards, report list, pipeline tab |
| `pages/LeadDashboard.jsx` | role=lead: all-team stats, report list, customer list |
| `pages/ReportDetail.jsx` | Single report view + inline meta edit form |
| `components/PipelineView.jsx` | Stage filter cards + customer list + opens AddCustomerModal / CustomerDetailModal |
| `components/CustomerDetailModal.jsx` | Main modal: info panel (left) + interaction thread (right) |
| `components/AddCustomerModal.jsx` | Quick-add customer → calls `quickAddCustomer` |
| `components/DrilldownModal.jsx` | Stat card drill-down: quote lists or customer lists |
| `components/StatCard.jsx` | KPI card — supports `rows` prop for split counts |
| `components/CustomerCard.jsx` | Customer row used in ReportDetail |
| `components/QuoteForm.jsx` | Reusable quote entry form (used in AddCustomerModal + TodayInteractionForm) |
| `components/DateFilter.jsx` | Date range picker + `useDateFilter` hook |

---

## Key patterns

### Modals
- Fixed overlay, `z-index: 1000` (nested modals use `z-index: 1100`)
- Click overlay to close: `onClick={e => { if (e.target === e.currentTarget) onClose(); }}`
- Body scrolls independently: `overflowY: 'auto'` on the inner card, not the overlay

### StatCard `rows` prop
When a stat needs to show sub-counts (e.g. Chờ Follow), pass `rows` instead of `value`:
```jsx
<StatCard
  label="Chờ Follow" icon="⏰" color="var(--danger)"
  onClick={() => setDrilldown('waiting_follow_up')}
  rows={[
    { label: 'Hôm nay',  value: stats.follow_today,    color: '#d97706' },
    { label: 'Sắp tới',  value: stats.follow_upcoming, color: '#3b82f6' },
    { label: 'Quá hạn',  value: stats.overdue,         color: '#ef4444' },
  ]}
/>
```

### State lifting for follow-up widgets
React Query's `invalidateQueries` re-mounts children and resets their local state.
Rule: any `useState` that must survive a query refetch lives in the nearest stable parent and is passed as props — not owned by the component that renders it.

Concrete case: `FollowUpWidget` takes `{ showInput, setShowInput, note, setNote }` as props.
`UpdateRow` and `InteractionFollowUpWidget` own that state and pass it down.
Do not move state back into `FollowUpWidget`.

### DrilldownModal — split-date layout
`DRILL_CONFIG` entries with `splitByDate: true` bypass the normal render path.
The modal partitions rows client-side:
```js
const today  = new Date().toISOString().slice(0, 10);
const plus3  = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
todayRows    = data.filter(c => c.follow_up_date?.slice(0, 10) === today);
upcomingRows = data.filter(c => c.follow_up_date?.slice(0, 10) > today && <= plus3);
overdueRows  = data.filter(c => c.follow_up_date?.slice(0, 10) < today);
```
To add a new split-date type, add `splitByDate: true` to its `DRILL_CONFIG` entry and make sure the backend drilldown returns all relevant rows (not filtered to `<= CURRENT_DATE` only).

### Avatar
```jsx
<div className="avatar" style={{ background: u.avatar_color }}>{u.code}</div>
```
`avatar_color` is a hex string stored in DB. `code` is the 2-3 char short code.
Size variants: `avatar-sm`, `avatar-lg`.

---

## api/index.js rules

- Every endpoint has one named export: verb + noun (`getCustomers`, `updateQuote`, `markUpdateComplete`)
- Response interceptor unwraps `.data` — components receive the payload directly
- Active customer exports: `getCustomers`, `updateCustomer` — `createCustomer` / `deleteCustomer` were removed; use `quickAddCustomer` instead
- Add to this file first; if it's already there, don't add a duplicate

---

## Business logic in the UI

### Quote price field
Stored as a JSON string `[{carrier, price, cost}, ...]` (up to 5 options).
Parse with `parseOptions(price, carrier)` — defined in `CustomerDetailModal.jsx` and `CustomerCard.jsx`. Falls back to a single legacy plain-text option if parsing fails.

### Customer code
Only the first interaction for a new company has a `customer_code`. Find it with:
```js
interactions.find(i => i.customer_code)?.customer_code
```

### Stage / status labels and colours
Canonical maps live at the top of each file that uses them (`STAGE_INFO`, `STATUS_LABEL`, `STATUS_COLOR`, `TYPE_LABEL`, etc.). Don't import them from a shared module — copy the map into the file that needs it.

### Chờ Follow stat — three groups
The `GET /api/stats` response includes:
- `follow_today` — `follow_up_date = TODAY`
- `follow_upcoming` — `follow_up_date` between tomorrow and +3 days
- `overdue` — `follow_up_date < TODAY`
- `waiting_follow_up` — their sum (kept for reference)
All three share the same completion exclusion logic.
