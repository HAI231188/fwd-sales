# FWD Sales — Hệ thống Quản lý Kinh doanh Freight Forwarding

Ứng dụng quản lý báo cáo kinh doanh cho công ty freight forwarding tại Việt Nam.

## Tech Stack

- **Backend**: Node.js + Express + PostgreSQL
- **Frontend**: React + Vite + TanStack Query
- **Deploy**: Railway.app ready

## Tính năng

- 🔐 Đăng nhập theo nhân viên (no password - prototype)
- 📊 Dashboard Trưởng Phòng với bộ lọc ngày + drill-down stats
- 📋 Báo cáo hàng ngày với khách hàng + báo giá
- 👥 Quản lý khách hàng: Lưu / Đã liên hệ / Đã báo giá
- 📦 Báo giá chi tiết: Sea 🚢 / Air ✈️ / Road 🚛
- ⚡ Tracking "sắp chốt" + follow-up dates
- 🌙 Dark theme với màu teal chủ đạo

## Cài đặt Local

### 1. Clone & cài dependencies

```bash
cd fwd-sales
npm run install:all
```

### 2. Cấu hình PostgreSQL

Tạo database:
```sql
CREATE DATABASE fwd_sales;
```

Copy file môi trường:
```bash
cp backend/.env.example backend/.env
# Chỉnh sửa DATABASE_URL trong backend/.env
```

### 3. Migrate và seed dữ liệu

```bash
npm run db:setup
```

### 4. Chạy development

Terminal 1 (Backend):
```bash
npm run dev:backend
# Chạy tại http://localhost:3001
```

Terminal 2 (Frontend):
```bash
npm run dev:frontend
# Chạy tại http://localhost:5173
```

## Deploy lên Railway.app

### Bước 1: Tạo project trên Railway

1. Vào [railway.app](https://railway.app) → New Project
2. Deploy from GitHub repo

### Bước 2: Thêm PostgreSQL

1. Trong Railway project → Add Service → Database → PostgreSQL
2. Railway tự động cấp `DATABASE_URL`

### Bước 3: Cấu hình environment variables

```
DATABASE_URL=<tự động từ Railway PostgreSQL>
NODE_ENV=production
PORT=3001
```

### Bước 4: Chạy migration + seed

Trong Railway → Service → Shell:
```bash
cd backend && npm run db:migrate && npm run db:seed
```

### Bước 5: Deploy

Railway sẽ tự build và deploy theo `railway.toml`

## Cấu trúc thư mục

```
fwd-sales/
├── backend/
│   ├── src/
│   │   ├── db/
│   │   │   ├── index.js        # PostgreSQL pool
│   │   │   ├── schema.sql      # Database schema
│   │   │   ├── seed.sql        # Sample data
│   │   │   ├── migrate.js      # Migration script
│   │   │   └── seed.js         # Seed script
│   │   ├── middleware/
│   │   │   └── auth.js         # Token-based auth
│   │   ├── routes/
│   │   │   ├── auth.js         # Login, user list
│   │   │   ├── reports.js      # Daily reports CRUD
│   │   │   ├── customers.js    # Customers CRUD
│   │   │   ├── quotes.js       # Quotes CRUD
│   │   │   └── stats.js        # Dashboard stats + drilldown
│   │   └── app.js
│   ├── server.js
│   ├── .env.example
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── api/index.js        # Axios API client
│   │   ├── components/
│   │   │   ├── Navbar.jsx
│   │   │   ├── StatCard.jsx
│   │   │   ├── DateFilter.jsx  # Hôm nay/7 ngày/Tháng/Tùy chọn
│   │   │   ├── DrilldownModal.jsx
│   │   │   ├── CustomerCard.jsx
│   │   │   ├── QuoteForm.jsx
│   │   │   ├── CustomerForm.jsx
│   │   │   └── ReportForm.jsx
│   │   ├── pages/
│   │   │   ├── Login.jsx
│   │   │   ├── LeadDashboard.jsx
│   │   │   ├── SalesDashboard.jsx
│   │   │   └── ReportDetail.jsx
│   │   ├── App.jsx
│   │   ├── index.css
│   │   └── main.jsx
│   ├── vite.config.js
│   └── package.json
├── railway.toml
└── README.md
```

## API Endpoints

### Auth
- `GET /api/auth/users` — Danh sách users
- `POST /api/auth/login` — Đăng nhập (body: `{userId}`)
- `GET /api/auth/me` — User hiện tại

### Reports
- `GET /api/reports?startDate=&endDate=&userId=` — Danh sách báo cáo
- `POST /api/reports` — Tạo báo cáo (+ customers + quotes trong 1 request)
- `GET /api/reports/:id` — Chi tiết báo cáo
- `PUT /api/reports/:id` — Cập nhật summary
- `DELETE /api/reports/:id` — Xóa báo cáo

### Customers
- `GET /api/customers?userId=&interactionType=&startDate=&endDate=`
- `POST /api/customers` — Thêm khách hàng vào báo cáo
- `PUT /api/customers/:id` — Cập nhật
- `DELETE /api/customers/:id` — Xóa

### Quotes
- `POST /api/quotes` — Thêm báo giá
- `PUT /api/quotes/:id` — Cập nhật
- `DELETE /api/quotes/:id` — Xóa

### Stats
- `GET /api/stats?startDate=&endDate=&userId=` — Dashboard stats
- `GET /api/stats/drilldown/:type` — Chi tiết theo loại (booked/follow_up/closing_soon/contacts/total_quotes/waiting_follow_up)

## Nhân viên mẫu

| Code | Tên | Vai trò |
|------|-----|---------|
| TP | Trưởng Phòng | Lead (xem tất cả) |
| AN | Nguyễn Văn An | Sales |
| BI | Trần Thị Bình | Sales |
| CU | Lê Minh Cường | Sales |
| DU | Phạm Thị Dung | Sales |
| EM | Hoàng Văn Em | Sales |
| FU | Vũ Thị Fương | Sales |
