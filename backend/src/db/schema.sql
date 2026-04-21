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
