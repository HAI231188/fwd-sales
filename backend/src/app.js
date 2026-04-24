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

// TEMP DEBUG — remove after investigation
app.get('/api/debug/recent-jobs', async (req, res) => {
  const db = require('./db');
  try {
    const { rows } = await db.query(`
      SELECT
        j.id, j.job_code, j.service_type, j.destination, j.created_at,
        ja.cus_id,      u_cus.name  AS cus_name,
        ja.ops_id,      u_ops.name  AS ops_name,
        ja.dieu_do_id,  u_dd.name   AS dieu_do_name,
        COALESCE(
          (SELECT json_agg(al ORDER BY al.id DESC)
           FROM (
             SELECT role, reason, fallback_used, ai_cost_usd, created_at
             FROM ai_assignment_logs
             WHERE job_id = j.id
             ORDER BY id DESC
             LIMIT 4
           ) al),
          '[]'::json
        ) AS ai_logs
      FROM jobs j
      LEFT JOIN LATERAL (
        SELECT * FROM job_assignments WHERE job_id = j.id ORDER BY id DESC LIMIT 1
      ) ja ON true
      LEFT JOIN users u_cus ON u_cus.id = ja.cus_id
      LEFT JOIN users u_ops ON u_ops.id = ja.ops_id
      LEFT JOIN users u_dd  ON u_dd.id  = ja.dieu_do_id
      ORDER BY j.id DESC
      LIMIT 10
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
