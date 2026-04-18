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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Temporary debug: follow-up customers — remove after diagnosis
app.get('/api/debug/followup', async (req, res) => {
  const db = require('./db');
  try {
    const [dateRow, rawRows, overdueAll, perUser] = await Promise.all([
      db.query(`SELECT CURRENT_DATE AS today, NOW() AS now`),
      db.query(`
        SELECT c.id, c.user_id, c.company_name, c.follow_up_date,
               c.follow_up_completed, c.interaction_type
        FROM customers c
        WHERE c.follow_up_date IS NOT NULL
          AND c.follow_up_completed = FALSE
          AND c.interaction_type != 'saved'
        ORDER BY c.follow_up_date
        LIMIT 20
      `),
      db.query(`
        SELECT COUNT(DISTINCT c.id) AS overdue_all
        FROM customers c
        WHERE c.follow_up_date < CURRENT_DATE
          AND c.follow_up_completed = FALSE
          AND c.interaction_type != 'saved'
      `),
      db.query(`
        SELECT c.user_id, COUNT(DISTINCT c.id) AS overdue_count
        FROM customers c
        WHERE c.follow_up_date < CURRENT_DATE
          AND c.follow_up_completed = FALSE
          AND c.interaction_type != 'saved'
        GROUP BY c.user_id
      `),
    ]);
    res.json({
      db_date: dateRow.rows[0],
      raw_matching_customers: rawRows.rows,
      overdue_count_no_user_filter: overdueAll.rows[0].overdue_all,
      overdue_per_user: perUser.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
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
