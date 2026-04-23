const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./routes/auth');
const reportRoutes = require('./routes/reports');
const customerRoutes = require('./routes/customers');
const quoteRoutes = require('./routes/quotes');
const statsRoutes = require('./routes/stats');
const pipelineRoutes = require('./routes/pipeline');
const jobsRoutes = require('./routes/jobs');

const app = express();

const frontendPath = path.join(__dirname, '../../frontend/dist');
const hasFrontend = fs.existsSync(frontendPath);

app.use(cors({
  origin: hasFrontend
    ? false
    : ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/quotes', quoteRoutes);
app.use('/api/stats', statsRoutes);
app.use('/api/pipeline', pipelineRoutes);
app.use('/api/jobs', jobsRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Temporary debug: TP jobs visibility — remove after investigation
app.get('/api/debug/tp-jobs', async (req, res) => {
  const db = require('./db');
  try {
    const [allJobs, pendingTotal, assignSummary] = await Promise.all([
      db.query(`SELECT j.id, j.job_code, j.status, j.deleted_at, j.service_type, ja.id AS ja_id, ja.cus_id, ja.ops_id, ja.dieu_do_id FROM jobs j LEFT JOIN job_assignments ja ON ja.job_id = j.id ORDER BY j.id DESC LIMIT 20`),
      db.query(`SELECT COUNT(*) AS v FROM jobs WHERE deleted_at IS NULL AND status = 'pending'`),
      db.query(`SELECT COUNT(*) AS total_ja, COUNT(ja.dieu_do_id) AS with_dd FROM jobs j LEFT JOIN job_assignments ja ON ja.job_id = j.id WHERE j.deleted_at IS NULL AND j.status = 'pending'`),
    ]);
    res.json({ jobs_with_assignments: allJobs.rows, pending_total: parseInt(pendingTotal.rows[0].v), assignment_summary: assignSummary.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Temporary debug: follow-up customers — remove after diagnosis
app.get('/api/debug/followup', async (req, res) => {
  const db = require('./db');
  const base = `FROM customers c WHERE c.follow_up_completed = FALSE AND c.interaction_type != 'saved'`;
  try {
    const [dateRow, todayCount, todayRows, upcomingCount, upcomingRows, overdueCount, overdueRows, ciuRows, users] = await Promise.all([
      db.query(`SELECT CURRENT_DATE AS today, NOW() AS now`),
      db.query(`SELECT COUNT(DISTINCT c.id) AS v ${base} AND c.follow_up_date = CURRENT_DATE`),
      db.query(`SELECT c.id, c.user_id, c.company_name, c.follow_up_date ${base} AND c.follow_up_date = CURRENT_DATE ORDER BY c.company_name`),
      db.query(`SELECT COUNT(DISTINCT c.id) AS v ${base} AND c.follow_up_date > CURRENT_DATE AND c.follow_up_date <= CURRENT_DATE + INTERVAL '7 days'`),
      db.query(`SELECT c.id, c.user_id, c.company_name, c.follow_up_date ${base} AND c.follow_up_date > CURRENT_DATE AND c.follow_up_date <= CURRENT_DATE + INTERVAL '7 days' ORDER BY c.follow_up_date`),
      db.query(`SELECT COUNT(DISTINCT c.id) AS v ${base} AND c.follow_up_date < CURRENT_DATE`),
      db.query(`SELECT c.id, c.user_id, c.company_name, c.follow_up_date ${base} AND c.follow_up_date < CURRENT_DATE ORDER BY c.follow_up_date DESC`),
      db.query(`
        SELECT ciu.id, ciu.customer_id, ciu.follow_up_date, ciu.completed, c.user_id, c.company_name
        FROM customer_interaction_updates ciu
        JOIN customers c ON c.id = ciu.customer_id
        WHERE ciu.follow_up_date IS NOT NULL AND ciu.completed = FALSE
        ORDER BY ciu.follow_up_date
        LIMIT 20
      `),
      db.query(`SELECT id, name, role FROM users ORDER BY id`),
    ]);
    res.json({
      db_date: dateRow.rows[0],
      today_count: parseInt(todayCount.rows[0].v),
      today_rows: todayRows.rows,
      upcoming_count: parseInt(upcomingCount.rows[0].v),
      upcoming_rows: upcomingRows.rows,
      overdue_count: parseInt(overdueCount.rows[0].v),
      overdue_rows: overdueRows.rows,
      pending_ciu_follow_ups: ciuRows.rows,
      users,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Temporary debug: test AI assignment module end-to-end — remove after verification
app.get('/api/debug/test-ai-assignment', async (req, res) => {
  const db = require('./db');
  const { assignCus, assignOps } = require('./services/ai-assignment');

  const dummyJob = {
    id: null,
    customer_name: 'Công ty TNHH TEST ABC',
    service_type: 'both',
    pol: 'HAN',
    pod: 'SIN',
    destination: 'hai_phong',
    other_services: { kiem_dich: true },
  };

  const results = {};

  try {
    results.assignCus = await assignCus(dummyJob, db.pool);
  } catch (err) {
    results.assignCus = { error: err.message };
  }

  try {
    results.assignOps = await assignOps(dummyJob, db.pool);
  } catch (err) {
    results.assignOps = { error: err.message };
  }

  res.json({ job: dummyJob, results });
});

// Serve frontend — always, whenever the dist folder exists
if (hasFrontend) {
  app.use(express.static(frontendPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
  console.log('📁 Serving frontend from', frontendPath);
} else {
  console.log('⚠️  No frontend/dist found — running API-only mode');
}

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({
    error: err.message || 'Internal Server Error',
  });
});

module.exports = app;
