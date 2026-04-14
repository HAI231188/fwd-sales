# Frontend — Component & UI Guide

> Read `../../CLAUDE.md` first for architecture, modules, and golden rules.

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
