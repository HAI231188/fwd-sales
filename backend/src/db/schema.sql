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
