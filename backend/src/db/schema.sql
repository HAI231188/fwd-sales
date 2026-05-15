-- ============================================================
-- FWD Sales Management Schema
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  code VARCHAR(10) NOT NULL UNIQUE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('sales', 'lead')),
  avatar_color VARCHAR(20) DEFAULT '#00d4aa',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report_date DATE NOT NULL,
  total_contacts INTEGER DEFAULT 0,
  new_customers INTEGER DEFAULT 0,
  issues TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(user_id, report_date)
);

CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_name VARCHAR(200) NOT NULL,
  contact_person VARCHAR(100),
  phone VARCHAR(50),
  source VARCHAR(30) CHECK (source IN ('cold_call', 'zalo_facebook', 'referral', 'email', 'direct', 'other')),
  industry VARCHAR(100),
  interaction_type VARCHAR(20) NOT NULL CHECK (interaction_type IN ('saved', 'contacted', 'quoted')),
  needs TEXT,
  notes TEXT,
  next_action TEXT,
  follow_up_date DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quotes (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  cargo_name VARCHAR(200),
  monthly_volume_cbm DECIMAL(10,2),
  monthly_volume_kg DECIMAL(12,2),
  monthly_volume_containers VARCHAR(100),
  route VARCHAR(300),
  cargo_ready_date DATE,
  mode VARCHAR(10) CHECK (mode IN ('sea', 'air', 'road')),
  carrier VARCHAR(100),
  transit_time VARCHAR(100),
  price TEXT,
  status VARCHAR(20) DEFAULT 'quoting' CHECK (status IN ('quoting', 'follow_up', 'booked', 'lost')),
  follow_up_notes TEXT,
  lost_reason TEXT,
  closing_soon BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_reports_user_id ON reports(user_id);
CREATE INDEX IF NOT EXISTS idx_reports_date ON reports(report_date);
CREATE INDEX IF NOT EXISTS idx_customers_report_id ON customers(report_id);
CREATE INDEX IF NOT EXISTS idx_customers_user_id ON customers(user_id);
CREATE INDEX IF NOT EXISTS idx_customers_follow_up ON customers(follow_up_date);
CREATE INDEX IF NOT EXISTS idx_quotes_customer_id ON quotes(customer_id);
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
CREATE INDEX IF NOT EXISTS idx_quotes_closing_soon ON quotes(closing_soon);

-- Auth columns (added via migration)
ALTER TABLE users ADD COLUMN IF NOT EXISTS username VARCHAR(50);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- Phase 5 Step 3 Part 2 CP1 — Gmail SMTP per-user setup (encrypted at rest).
-- All nullable so existing users continue working without configuration; DD
-- fills these in via /change-password (CP2). The encrypted column stores the
-- ciphertext of a Gmail App Password (not the plain Google password) — CP2
-- handles the AES-GCM encrypt/decrypt with a server-side key.
ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_address VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_app_password_encrypted TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_display_name VARCHAR(200);

-- ============================================================
-- Pipeline feature
-- ============================================================

CREATE TABLE IF NOT EXISTS customer_pipeline (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  sales_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_name VARCHAR(200) NOT NULL,
  contact_person VARCHAR(100),
  phone VARCHAR(50),
  industry VARCHAR(100),
  source VARCHAR(30),
  stage VARCHAR(20) NOT NULL DEFAULT 'new'
    CHECK (stage IN ('new', 'dormant', 'following', 'booked')),
  last_activity_date DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pipeline_history (
  id SERIAL PRIMARY KEY,
  pipeline_id INTEGER NOT NULL REFERENCES customer_pipeline(id) ON DELETE CASCADE,
  from_stage VARCHAR(20),
  to_stage VARCHAR(20) NOT NULL,
  changed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Link customers back to their pipeline entry
ALTER TABLE customers ADD COLUMN IF NOT EXISTS pipeline_id INTEGER REFERENCES customer_pipeline(id) ON DELETE SET NULL;

-- One pipeline entry per salesperson per company (case-insensitive)
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_sales_company
  ON customer_pipeline(sales_id, LOWER(company_name));

CREATE INDEX IF NOT EXISTS idx_pipeline_sales_id ON customer_pipeline(sales_id);
CREATE INDEX IF NOT EXISTS idx_pipeline_stage ON customer_pipeline(stage);
CREATE INDEX IF NOT EXISTS idx_pipeline_last_activity ON customer_pipeline(last_activity_date);
CREATE INDEX IF NOT EXISTS idx_pipeline_history_pipeline ON pipeline_history(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_customers_pipeline_id ON customers(pipeline_id);

-- Optional customer qualification fields
ALTER TABLE customers ADD COLUMN IF NOT EXISTS potential_level   VARCHAR(10)   CHECK (potential_level IN ('high', 'medium', 'low'));
ALTER TABLE customers ADD COLUMN IF NOT EXISTS decision_maker   BOOLEAN       DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS preferred_contact VARCHAR(50);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS reason_not_closed TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS estimated_value  NUMERIC(15,2);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS competitor       TEXT;

-- Customer contact & identity fields
ALTER TABLE customers ADD COLUMN IF NOT EXISTS address      TEXT;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS tax_code     VARCHAR(20);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS customer_code VARCHAR(10);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_customer_code
  ON customers(customer_code) WHERE customer_code IS NOT NULL;

-- Daily sequence counter for customer_code generation
CREATE TABLE IF NOT EXISTS customer_code_seq (
  seq_date DATE    PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0
);

-- Interaction updates (threaded notes under each customer interaction)
CREATE TABLE IF NOT EXISTS customer_interaction_updates (
  id            SERIAL PRIMARY KEY,
  customer_id   INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  note          TEXT NOT NULL,
  follow_up_date DATE,
  created_at    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_interaction_updates_customer ON customer_interaction_updates(customer_id);

ALTER TABLE customer_interaction_updates ADD COLUMN IF NOT EXISTS completed        BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE customer_interaction_updates ADD COLUMN IF NOT EXISTS completion_note TEXT;

-- Follow-up completion on interaction cards (customers table)
ALTER TABLE customers ADD COLUMN IF NOT EXISTS follow_up_completed BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS follow_up_result    TEXT;

-- Pipeline delete requests (sales requests, lead approves/rejects)
CREATE TABLE IF NOT EXISTS pipeline_delete_requests (
  id           SERIAL PRIMARY KEY,
  pipeline_id  INTEGER NOT NULL REFERENCES customer_pipeline(id) ON DELETE CASCADE,
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  reviewed_at  TIMESTAMP WITH TIME ZONE,
  reviewed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_delete_requests_pending
  ON pipeline_delete_requests(pipeline_id) WHERE status = 'pending';

-- ============================================================
-- LOG Module
-- ============================================================

-- Expand role check to include LOG roles
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('sales', 'lead', 'truong_phong_log', 'dieu_do', 'cus', 'cus1', 'cus2', 'cus3', 'ops'));

CREATE TABLE IF NOT EXISTS jobs (
  id                SERIAL PRIMARY KEY,
  job_code          VARCHAR(50),
  customer_id       INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  customer_name     VARCHAR(200) NOT NULL,
  customer_address  TEXT,
  customer_tax_code VARCHAR(30),
  sales_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  pol               VARCHAR(100),
  pod               VARCHAR(100),
  bill_number       VARCHAR(100),
  cont_number       VARCHAR(100),
  cont_type         VARCHAR(50),
  seal_number       VARCHAR(100),
  etd               DATE,
  eta               DATE,
  tons              DECIMAL(10,2),
  cbm               DECIMAL(10,2),
  deadline          TIMESTAMP WITH TIME ZONE,
  service_type      VARCHAR(10) CHECK (service_type IN ('tk', 'truck', 'both')),
  other_services    JSONB DEFAULT '{}',
  assignment_mode   VARCHAR(10) DEFAULT 'auto' CHECK (assignment_mode IN ('auto', 'manual')),
  status            VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'completed')),
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at        TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_assignments (
  id                           SERIAL PRIMARY KEY,
  job_id                       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  cus_id                       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ops_id                       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_by                  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assigned_at                  TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  assignment_mode              VARCHAR(10) CHECK (assignment_mode IN ('auto', 'manual')),
  cus_confirm_status           VARCHAR(30) DEFAULT 'pending'
    CHECK (cus_confirm_status IN ('pending', 'confirmed', 'adjustment_requested')),
  cus_confirmed_at             TIMESTAMP WITH TIME ZONE,
  adjustment_reason            TEXT,
  adjustment_deadline_proposed TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS job_deadline_requests (
  id                SERIAL PRIMARY KEY,
  job_id            INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  requested_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  current_deadline  TIMESTAMP WITH TIME ZONE,
  proposed_deadline TIMESTAMP WITH TIME ZONE,
  reason            TEXT,
  status            VARCHAR(10) DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at       TIMESTAMP WITH TIME ZONE
);

CREATE TABLE IF NOT EXISTS job_tk (
  id                 SERIAL PRIMARY KEY,
  job_id             INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  cus_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  tk_datetime        TIMESTAMP WITH TIME ZONE,
  tk_number          VARCHAR(100),
  tk_flow            VARCHAR(50),
  tk_status          VARCHAR(20) DEFAULT 'chua_truyen'
    CHECK (tk_status IN ('chua_truyen', 'dang_lam', 'thong_quan', 'giai_phong', 'bao_quan')),
  tq_datetime        TIMESTAMP WITH TIME ZONE,
  services_completed JSONB DEFAULT '{}',
  delivery_datetime  TIMESTAMP WITH TIME ZONE,
  delivery_location  TEXT,
  truck_booked       BOOLEAN DEFAULT FALSE,
  completed_at       TIMESTAMP WITH TIME ZONE,
  notes              TEXT
);

CREATE TABLE IF NOT EXISTS job_truck (
  id                SERIAL PRIMARY KEY,
  job_id            INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  transport_name    VARCHAR(200),
  planned_datetime  TIMESTAMP WITH TIME ZONE,
  actual_datetime   TIMESTAMP WITH TIME ZONE,
  vehicle_number    VARCHAR(50),
  pickup_location   TEXT,
  delivery_location TEXT,
  cost              DECIMAL(15,2),
  completed_at      TIMESTAMP WITH TIME ZONE,
  notes             TEXT
);

CREATE TABLE IF NOT EXISTS job_ops_task (
  id           SERIAL PRIMARY KEY,
  job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  ops_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  content      TEXT,
  port         VARCHAR(100),
  deadline     TIMESTAMP WITH TIME ZONE,
  completed    BOOLEAN DEFAULT FALSE,
  completed_at TIMESTAMP WITH TIME ZONE,
  notes        TEXT
);

CREATE TABLE IF NOT EXISTS job_history (
  id         SERIAL PRIMARY KEY,
  job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  field_name VARCHAR(100),
  old_value  TEXT,
  new_value  TEXT,
  changed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_jobs_status            ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created_at        ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_deadline          ON jobs(deadline);
CREATE INDEX IF NOT EXISTS idx_jobs_sales_id          ON jobs(sales_id);
CREATE INDEX IF NOT EXISTS idx_job_assignments_job_id ON job_assignments(job_id);
CREATE INDEX IF NOT EXISTS idx_job_assignments_cus_id ON job_assignments(cus_id);
CREATE INDEX IF NOT EXISTS idx_job_assignments_ops_id ON job_assignments(ops_id);
CREATE INDEX IF NOT EXISTS idx_job_tk_job_id          ON job_tk(job_id);
CREATE INDEX IF NOT EXISTS idx_job_truck_job_id       ON job_truck(job_id);
CREATE INDEX IF NOT EXISTS idx_job_ops_task_job_id    ON job_ops_task(job_id);

ALTER TABLE job_ops_task ADD COLUMN IF NOT EXISTS task_type VARCHAR(30);
ALTER TABLE job_assignments ADD COLUMN IF NOT EXISTS ops_done BOOLEAN DEFAULT FALSE;
ALTER TABLE job_assignments ADD COLUMN IF NOT EXISTS ops_done_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_job_history_job_id     ON job_history(job_id);
CREATE INDEX IF NOT EXISTS idx_job_dl_req_job_id      ON job_deadline_requests(job_id);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS deleted_at  TIMESTAMP WITH TIME ZONE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cargo_type  VARCHAR(3) DEFAULT 'fcl';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS so_kien     INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kg          DECIMAL(10,2);

CREATE TABLE IF NOT EXISTS job_containers (
  id          SERIAL PRIMARY KEY,
  job_id      INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  cont_number VARCHAR(100),
  cont_type   VARCHAR(10) NOT NULL,
  seal_number VARCHAR(100),
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_containers_job_id ON job_containers(job_id);
-- Phase 5 Step 3 Part 2 CP3.5b — per-container weight, surfaced in the
-- planning email per spec ("Cont X (40HC) - 28.50 tấn"). Nullable so
-- existing rows + cont creation without weight still work.
ALTER TABLE job_containers ADD COLUMN IF NOT EXISTS weight_tons DECIMAL(10,2);

CREATE TABLE IF NOT EXISTS job_delete_requests (
  id           SERIAL PRIMARY KEY,
  job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason       TEXT,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected')),
  reviewed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMP WITH TIME ZONE,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_job_delete_req_job_id ON job_delete_requests(job_id);
CREATE INDEX IF NOT EXISTS idx_job_delete_req_status ON job_delete_requests(status);

-- ============================================================
-- Seed: LOG module user accounts (idempotent)
-- ============================================================
INSERT INTO users (name, code, role, avatar_color, username, password_hash) VALUES
  ('Trưởng Phòng LOG', 'TPL', 'truong_phong_log', '#7c3aed', 'tpl',   '$2b$10$U0IzDXeiRB2oEqzvmWvmquE89tDB2MgT.hECmSnvcAWSWFrAbkM82'),
  ('CUS',              'CUS', 'cus',              '#0891b2', 'cus',   '$2b$10$kRy0tAQAX5TuE.P8ddXZS.e5SpLjnEEKlD.9reRQ.zCyPt/q5rPPi'),
  ('CUS 1',            'C1',  'cus1',             '#0e7490', 'cus1',  '$2b$10$mmTJ8rONGtiIQt8S7FJHjeYIMT3fZX.JTfloLbkIMPvkQum1aMIBq'),
  ('CUS 2',            'C2',  'cus2',             '#155e75', 'cus2',  '$2b$10$zChgZeM15xuN/QPTi1W1OusTyO/KSw6deuoJ0h1YCBpcm8g99Iix.'),
  ('CUS 3',            'C3',  'cus3',             '#164e63', 'cus3',  '$2b$10$FuH1N6BDemLWxRlI9XlvFOw.A/sbYmbld6jmSgZnqg/G8P66SLNKa'),
  ('Điều Độ',          'DD',  'dieu_do',          '#3b82f6', 'dd',    '$2b$10$bk1oLqZU9fPimlswTltyveTUUtBcXJ3BEbMkDIuhjaOWKY20Tmb9G'),
  ('OPS 1',            'O1',  'ops',              '#16a34a', 'ops1',  '$2b$10$rJ.h73GY2s6TyngycrHNsuUJMAjQZh935nrdH1.I0pIqz5PGvnCSa'),
  ('OPS 2',            'O2',  'ops',              '#15803d', 'ops2',  '$2b$10$3R8RWPwhY3s7TBasctdv6.7DnfNqWHY.mSXXjoIAWLl466uvXbu3.')
ON CONFLICT (code) DO NOTHING;

-- Backfill username for LOG users already inserted without it
UPDATE users SET username = 'tpl'  WHERE code = 'TPL' AND username IS NULL;
UPDATE users SET username = 'cus'  WHERE code = 'CUS' AND username IS NULL;
UPDATE users SET username = 'cus1' WHERE code = 'C1'  AND username IS NULL;
UPDATE users SET username = 'cus2' WHERE code = 'C2'  AND username IS NULL;
UPDATE users SET username = 'cus3' WHERE code = 'C3'  AND username IS NULL;
UPDATE users SET username = 'dd'   WHERE code = 'DD'  AND username IS NULL;
UPDATE users SET username = 'ops1' WHERE code = 'O1'  AND username IS NULL;
UPDATE users SET username = 'ops2' WHERE code = 'O2'  AND username IS NULL;

-- ============================================================
-- Assignment system v2
-- ============================================================

-- Drop old per-job assignment_mode (replaced by global log_settings table)
ALTER TABLE jobs DROP COLUMN IF EXISTS assignment_mode;

-- Destination field: 'hai_phong' triggers OPS auto-assign, NULL = no OPS routing
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS destination VARCHAR(20);

-- Hạn lệnh: customs clearance deadline (datetime)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS han_lenh TIMESTAMPTZ;

-- Document numbers
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS si_number VARCHAR(100);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS mbl_no VARCHAR(100);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS hbl_no VARCHAR(100);

-- Remove legacy bill_number field (replaced by si_number/mbl_no/hbl_no)
ALTER TABLE jobs DROP COLUMN IF EXISTS bill_number;

-- Global LOG department settings (single-row config, id=1 always)
CREATE TABLE IF NOT EXISTS log_settings (
  id              SERIAL PRIMARY KEY,
  assignment_mode VARCHAR(10) DEFAULT 'auto' CHECK (assignment_mode IN ('auto', 'manual')),
  updated_by      INTEGER REFERENCES users(id),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
INSERT INTO log_settings (id, assignment_mode) VALUES (1, 'auto') ON CONFLICT (id) DO NOTHING;

-- AI assignment audit log
CREATE TABLE IF NOT EXISTS ai_assignment_logs (
  id               SERIAL PRIMARY KEY,
  job_id           INTEGER REFERENCES jobs(id),
  assigned_user_id INTEGER REFERENCES users(id),
  role             VARCHAR(10),
  reason           TEXT,
  ai_cost_usd      NUMERIC(10,6),
  fallback_used    BOOLEAN DEFAULT FALSE,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_logs_job_id ON ai_assignment_logs(job_id);

-- OPS partner name (free-text, assigned by CUS when no auto-assigned ops)
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS ops_partner VARCHAR(100);

-- In-app notifications
CREATE TABLE IF NOT EXISTS notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER,
  type       VARCHAR(30),
  title      TEXT,
  body       TEXT,
  job_id     INTEGER NULL,
  read       BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);

-- Idempotent migration: align with spec (body→message, read→read_at)
-- NOTE: do NOT add an index on the legacy `read` column — it is dropped below.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notifications' AND column_name='body')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notifications' AND column_name='message') THEN
    ALTER TABLE notifications RENAME COLUMN body TO message;
  END IF;
END $$;

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notifications' AND column_name='read') THEN
    UPDATE notifications SET read_at = created_at WHERE read = TRUE AND read_at IS NULL;
    ALTER TABLE notifications DROP COLUMN read;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_notifications_inbox
  ON notifications(user_id, read_at, created_at DESC);

-- Điều Độ assignment: dieu_do staff assigned per truck/both job
ALTER TABLE job_assignments ADD COLUMN IF NOT EXISTS dieu_do_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_job_assignments_dieu_do_id ON job_assignments(dieu_do_id);

-- Backfill: assign existing truck/both jobs to dieu_do user with lowest workload
DO $$
DECLARE
  dd_user_id INTEGER;
BEGIN
  SELECT id INTO dd_user_id FROM users WHERE role = 'dieu_do'
    ORDER BY (
      SELECT COUNT(*) FROM job_assignments ja2
      WHERE ja2.dieu_do_id = users.id
    ) ASC, id
    LIMIT 1;
  IF dd_user_id IS NOT NULL THEN
    UPDATE job_assignments SET dieu_do_id = dd_user_id
    WHERE dieu_do_id IS NULL
      AND job_id IN (
        SELECT id FROM jobs WHERE service_type IN ('truck','both') AND deleted_at IS NULL
      );
    INSERT INTO job_assignments (job_id, dieu_do_id, assignment_mode)
    SELECT j.id, dd_user_id, 'auto'
    FROM jobs j
    LEFT JOIN job_assignments ja ON ja.job_id = j.id
    WHERE j.service_type IN ('truck','both')
      AND j.deleted_at IS NULL
      AND ja.id IS NULL;
  END IF;
END $$;

-- Deduplicate job_assignments (keep latest row per job) then enforce one-row-per-job
DO $$
BEGIN
  DELETE FROM job_assignments
  WHERE id NOT IN (
    SELECT DISTINCT ON (job_id) id FROM job_assignments ORDER BY job_id, id DESC
  );
EXCEPTION WHEN others THEN NULL;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_assignments_unique_job_id ON job_assignments(job_id);

-- ============================================================
-- Transport Companies (Quản lý tên vận tải)
-- Picker-only UI in DieuDo dashboard; soft-delete for safety.
-- ============================================================
CREATE TABLE IF NOT EXISTS transport_companies (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(200) NOT NULL,
  tax_code        VARCHAR(30),
  address         TEXT,
  email           VARCHAR(200),
  phone           VARCHAR(30),
  contact_person  VARCHAR(100),
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  deleted_at      TIMESTAMPTZ
);
-- Case-insensitive uniqueness on name (defensive — VARCHAR UNIQUE alone is case-sensitive).
-- Excludes soft-deleted rows so a re-create after delete is allowed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transport_companies_name_lower
  ON transport_companies (LOWER(name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_transport_companies_active
  ON transport_companies (deleted_at) WHERE deleted_at IS NULL;

-- FK on job_truck — backward compat: legacy rows keep transport_name only with NULL FK.
-- ON DELETE SET NULL: hard-deleting a company nullifies the FK; transport_name snapshot survives.
ALTER TABLE job_truck ADD COLUMN IF NOT EXISTS transport_company_id
  INTEGER REFERENCES transport_companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_job_truck_transport_company_id ON job_truck(transport_company_id);

-- ============================================================
-- Invoice info + short name on customer_pipeline (L15)
-- Required for new customers added via CreateJobModal "Khách mới" tab.
-- Existing rows fill with empty-string defaults.
-- ============================================================
ALTER TABLE customer_pipeline ADD COLUMN IF NOT EXISTS company_full_name VARCHAR(300) DEFAULT '';
ALTER TABLE customer_pipeline ADD COLUMN IF NOT EXISTS invoice_address   TEXT          DEFAULT '';
ALTER TABLE customer_pipeline ADD COLUMN IF NOT EXISTS tax_code          VARCHAR(30)   DEFAULT '';
-- short_name removed (was duplicate of company_name; see L15 revision).
ALTER TABLE customer_pipeline DROP COLUMN IF EXISTS short_name;

-- ============================================================
-- Email CC list on transport_companies (L16) — stored as JSON-stringified array.
-- Reason: TEXT keeps the schema simple and lets us preserve order client-side.
-- A native TEXT[] would also work but JSON is closer to the wire format already
-- consumed by the frontend. Validate at backend; never trust on read.
-- ============================================================
ALTER TABLE transport_companies ADD COLUMN IF NOT EXISTS email_cc TEXT DEFAULT '[]';

-- ============================================================
-- Loại lô (Import/Export) — chosen at job creation, immutable post-create for now.
-- 'export' = Hàng xuất (default — vast majority of cases), 'import' = Hàng nhập.
-- NOT NULL with DEFAULT 'export' auto-backfills every existing row on ADD COLUMN.
-- CHECK enforced via DROP/ADD pair so the schema migration stays idempotent
-- (Postgres does not support `ADD CONSTRAINT ... IF NOT EXISTS`).
-- ============================================================
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS import_export VARCHAR(10) NOT NULL DEFAULT 'export';
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_import_export_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_import_export_check
  CHECK (import_export IN ('export', 'import'));

-- ============================================================
-- Phase 1: Multi-truck booking system
-- One job can have N truck_bookings (one chốt kế hoạch giao xe per vận tải).
-- Each booking references a subset of the job's containers via the M:N link
-- table (truck_booking_containers), with a UNIQUE constraint on container_id
-- to enforce that a single container can belong to at most one active booking
-- — splits and re-assigns happen by deleting the link row then re-inserting.
--
-- The legacy `job_truck` table is intentionally LEFT IN PLACE here. It is
-- deprecated by this system but several existing routes still read from it;
-- removal happens in a later phase once all readers migrate.
-- ============================================================
CREATE TABLE IF NOT EXISTS truck_bookings (
  id                    SERIAL PRIMARY KEY,
  job_id                INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  transport_company_id  INTEGER REFERENCES transport_companies(id) ON DELETE SET NULL,
  transport_name        VARCHAR(200) NOT NULL,                   -- snapshot per L13
  planned_datetime      TIMESTAMP WITH TIME ZONE NOT NULL,
  delivery_location     TEXT NOT NULL,
  cost                  NUMERIC(15,2),
  vehicle_number        VARCHAR(50),                             -- filled later when truck assigned
  notes                 TEXT,
  created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at            TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at          TIMESTAMP WITH TIME ZONE,                -- set when vehicle_number first filled
  deleted_at            TIMESTAMP WITH TIME ZONE                 -- soft delete (L17 pattern)
);
-- Phase 4.1 restore — fields the DD inline editor needs (idempotent per Golden Rule #3).
ALTER TABLE truck_bookings ADD COLUMN IF NOT EXISTS actual_datetime TIMESTAMP WITH TIME ZONE;
ALTER TABLE truck_bookings ADD COLUMN IF NOT EXISTS pickup_location TEXT;

-- Phase 5 Step 2 — "Đặt kế hoạch xe": CUS/Sales/TPL/DD can plan a delivery
-- (datetime + location + note) BEFORE a transport company is chosen. DD picks
-- the carrier in a later step ("Quản lý đặt xe" workspace, Step 3).
--   • transport_name: drop NOT NULL so planning rows can be created without a carrier.
--     The snapshot is still written when DD assigns a carrier (PATCH path in L13).
--     ALTER COLUMN ... DROP NOT NULL is itself idempotent in Postgres — no-op
--     if already nullable, so safe to re-run on every deploy.
--   • note: per-booking note from the PlanDeliveryModal form. Distinct from the
--     existing `notes` column which carries DD's transport/carrier-side note.
ALTER TABLE truck_bookings ALTER COLUMN transport_name DROP NOT NULL;
ALTER TABLE truck_bookings ADD COLUMN IF NOT EXISTS note TEXT;

-- Phase 5 Step 3 Part 2 CP4.1 — receiver contact at delivery location + driver note.
-- BBBG (the document the truck driver carries) needs the warehouse contact's
-- name + phone so the driver knows who to find on arrival, and a driver-only
-- note that is intentionally NOT included in the email body to the carrier.
--   • receiver_name / receiver_phone: "Người liên hệ tại kho" (per-booking, so
--     different bookings on the same job can target different warehouses).
--   • bbbg_note: text printed in BBBG only — does NOT bleed into the planning
--     mail body (existing `note` column handles transport-facing notes).
ALTER TABLE truck_bookings ADD COLUMN IF NOT EXISTS receiver_name  VARCHAR(200);
ALTER TABLE truck_bookings ADD COLUMN IF NOT EXISTS receiver_phone VARCHAR(50);
ALTER TABLE truck_bookings ADD COLUMN IF NOT EXISTS bbbg_note      TEXT;

-- Phase 5 Step 3 — booking_code (Mã kế hoạch).
-- Format "KH-{job_code}-{NN}", NN = 2-digit (or longer) sequential per job.
-- The number space is permanent: soft-deleted bookings still occupy their
-- number, so re-creating a booking after delete gets the next number, not
-- a recycled one. Routes generate the next code at INSERT time by reading
-- MAX(trailing digits) for the job, including soft-deleted rows.
ALTER TABLE truck_bookings ADD COLUMN IF NOT EXISTS booking_code VARCHAR(50);
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'idx_truck_bookings_booking_code_uniq'
  ) THEN
    CREATE UNIQUE INDEX idx_truck_bookings_booking_code_uniq
      ON truck_bookings(booking_code) WHERE booking_code IS NOT NULL;
  END IF;
END $$;

-- Backfill existing rows that still lack a code. Walk each job, start the
-- sequence from MAX(existing numbered code) so any pre-coded rows aren't
-- shadowed. Order uncoded rows by id so chronological creation order maps
-- to NN=01, 02, ... within a job. Idempotent — re-runs are no-ops once
-- every row has a code.
DO $$
DECLARE
  job_rec RECORD;
  bk_rec  RECORD;
  seq     INT;
BEGIN
  FOR job_rec IN
    SELECT DISTINCT j.id AS job_id, j.job_code
      FROM jobs j
      JOIN truck_bookings tb ON tb.job_id = j.id
     WHERE tb.booking_code IS NULL
       AND j.job_code IS NOT NULL
       AND j.job_code <> ''
  LOOP
    SELECT COALESCE(MAX(substring(booking_code from '\d+$')::int), 0)
      INTO seq
      FROM truck_bookings
     WHERE job_id = job_rec.job_id AND booking_code IS NOT NULL;
    FOR bk_rec IN
      SELECT id FROM truck_bookings
       WHERE job_id = job_rec.job_id AND booking_code IS NULL
       ORDER BY id
    LOOP
      seq := seq + 1;
      UPDATE truck_bookings
         SET booking_code = 'KH-' || job_rec.job_code || '-' || LPAD(seq::text, 2, '0')
       WHERE id = bk_rec.id;
    END LOOP;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS truck_booking_containers (
  id           SERIAL PRIMARY KEY,
  booking_id   INTEGER NOT NULL REFERENCES truck_bookings(id) ON DELETE CASCADE,
  container_id INTEGER NOT NULL REFERENCES job_containers(id) ON DELETE CASCADE,
  created_at   TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (container_id)                                          -- 1 container = at most 1 booking
);

-- Partial indexes filter out soft-deleted bookings so common-path queries
-- skip tombstones automatically.
CREATE INDEX IF NOT EXISTS idx_truck_bookings_job
  ON truck_bookings(job_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_truck_bookings_transport
  ON truck_bookings(transport_company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_truck_booking_containers_booking
  ON truck_booking_containers(booking_id);

-- Job-level booking status derived from container coverage + vehicle assignment:
--   'no_containers'         job has no containers at all
--   'chua_dat_xe'           job has containers but no active bookings
--   'dat_xe_1_phan'         at least one container booked, but some still loose
--   'da_dat_xe_du_cho_so_xe' all containers booked but some bookings missing vehicle_number
--   'da_giao_xong'          all containers booked AND all bookings have vehicle_number
CREATE OR REPLACE FUNCTION get_truck_booking_status(p_job_id INT) RETURNS TEXT AS $$
DECLARE
  total_cont            INT;
  booked_cont           INT;
  total_booking         INT;
  bookings_with_vehicle INT;
BEGIN
  SELECT COUNT(*) INTO total_cont FROM job_containers WHERE job_id = p_job_id;

  IF total_cont = 0 THEN
    RETURN 'no_containers';
  END IF;

  SELECT COUNT(DISTINCT tbc.container_id) INTO booked_cont
    FROM truck_booking_containers tbc
    JOIN truck_bookings tb ON tb.id = tbc.booking_id
   WHERE tb.job_id = p_job_id AND tb.deleted_at IS NULL;

  SELECT COUNT(*) INTO total_booking
    FROM truck_bookings WHERE job_id = p_job_id AND deleted_at IS NULL;

  SELECT COUNT(*) INTO bookings_with_vehicle
    FROM truck_bookings
   WHERE job_id = p_job_id AND deleted_at IS NULL
     AND vehicle_number IS NOT NULL AND vehicle_number != '';

  IF total_booking = 0 THEN
    RETURN 'chua_dat_xe';
  ELSIF booked_cont < total_cont THEN
    RETURN 'dat_xe_1_phan';
  ELSIF bookings_with_vehicle < total_booking THEN
    RETURN 'da_dat_xe_du_cho_so_xe';
  ELSE
    RETURN 'da_giao_xong';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- Soft delete on customer_pipeline (Data khách hàng — TP/lead management page)
-- Mirrors transport_companies pattern: deleted_at column + partial unique index
-- so a re-create for the same (sales, company) pair after soft-delete is allowed.
--
-- The OLD non-partial index `idx_pipeline_sales_company` is dropped and replaced
-- with a partial one `idx_pipeline_sales_company_active`. The L14 transfer logic
-- in routes/jobs.js POST `/` references the (sales_id, LOWER(company_name)) pair
-- in its ON CONFLICT clause — that clause MUST include `WHERE deleted_at IS NULL`
-- to match the partial-index predicate, otherwise Postgres can't infer the
-- constraint and the INSERT errors out. See routes/jobs.js.
-- ============================================================
ALTER TABLE customer_pipeline ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP WITH TIME ZONE;
DROP INDEX IF EXISTS idx_pipeline_sales_company;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_sales_company_active
  ON customer_pipeline(sales_id, LOWER(company_name)) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_pipeline_deleted_at
  ON customer_pipeline(deleted_at) WHERE deleted_at IS NOT NULL;

-- ============================================================
-- Phase 5 Step 3 Part 2 CP1 — Email history (Quản lý đặt xe → gửi mail kế hoạch)
--
-- One row per send-attempt from a DD/TPL user to a transport company for a
-- specific job, grouping N bookings into one mail. Snapshots both sides
-- (sender + recipient identity, full CC list) and the full rendered body
-- so "có thay đổi sau gửi" detection can diff `last_sent_data` against
-- the current truck_bookings state without needing a row-by-row audit
-- table. Soft-delete pattern (L17) so accidentally-sent rows can be
-- tombstoned without losing the audit trail.
--
-- mail_type:
--   'new'    — first send OR re-send for added bookings ("mail bổ sung").
--   'cancel' — mail HỦY when transport assignment changes or booking dropped.
--
-- status:
--   'sent'   — nodemailer accepted the message (CP3).
--   'failed' — caught exception; error_message holds the reason.
--
-- last_sent_data jsonb shape (one snapshot per row in this email):
--   { bookings: [{ id, booking_code, cont_number, cont_type,
--                  planned_datetime, delivery_location, cost,
--                  transport_company_id, transport_name, vehicle_number }] }
-- Comparing this against fresh getTruckBookings(job_id) gives the
-- field-level diff for "có thay đổi sau gửi" notifications (CP3+).
-- ============================================================
CREATE TABLE IF NOT EXISTS email_history (
  id                            SERIAL PRIMARY KEY,
  sender_user_id                INTEGER REFERENCES users(id) ON DELETE SET NULL,
  sender_email                  VARCHAR(255) NOT NULL,                       -- snapshot
  sender_display_name           VARCHAR(200),                                -- snapshot
  recipient_transport_company_id INTEGER REFERENCES transport_companies(id) ON DELETE SET NULL,
  recipient_email               VARCHAR(255) NOT NULL,                       -- snapshot
  recipient_cc                  TEXT,                                        -- JSON-array snapshot (L16)
  job_id                        INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  booking_ids                   INTEGER[] NOT NULL,                          -- truck_bookings.id list
  mail_type                     VARCHAR(20) NOT NULL CHECK (mail_type IN ('new', 'cancel')),
  subject                       TEXT NOT NULL,
  body                          TEXT NOT NULL,
  bbbg_attached                 BOOLEAN DEFAULT FALSE,                       -- attachment flag, no file storage
  status                        VARCHAR(20) NOT NULL CHECK (status IN ('sent', 'failed')),
  error_message                 TEXT,                                        -- only when status='failed'
  last_sent_data                JSONB NOT NULL,                              -- bookings snapshot for diff
  created_at                    TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  deleted_at                    TIMESTAMP WITH TIME ZONE                     -- soft delete (L17)
);

-- Partial indexes filter out soft-deleted rows so common-path queries
-- skip tombstones automatically (mirrors truck_bookings index pattern).
CREATE INDEX IF NOT EXISTS idx_email_history_job
  ON email_history(job_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_history_transport
  ON email_history(recipient_transport_company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_history_sender
  ON email_history(sender_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_email_history_status
  ON email_history(status) WHERE deleted_at IS NULL;
