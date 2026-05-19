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
const notificationsRoutes = require('./routes/notifications');
const searchRoutes = require('./routes/search');
const transportRoutes = require('./routes/transport');
const customerPipelineRoutes = require('./routes/customer-pipeline');
const truckBookingsRoutes = require('./routes/truck-bookings');
const usersRoutes = require('./routes/users');
const emailRoutes = require('./routes/email');
// KT2 — Accounting module exports two routers (both KT-role-gated):
//   accountingRouter  → mounted at /api/accounting (the GET list endpoint)
//   jobActionsRouter  → mounted at /api/jobs       (5 lifecycle mutations)
const { accountingRouter, jobActionsRouter: accountingJobActions } = require('./routes/accounting');
const encryption = require('./utils/encryption');

// One-shot startup check — logs whether email encryption is ready, so DD
// can see immediately whether Gmail features will work or 503 on use.
encryption.logStartupStatus();

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
app.use('/api/notifications', notificationsRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/transport-companies', transportRoutes);
app.use('/api/customer-pipeline', customerPipelineRoutes);
app.use('/api/truck-bookings', truckBookingsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/email', emailRoutes);
// KT2 — Accounting endpoints. accountingJobActions mounts AFTER jobsRoutes
// (line 48 above) — Express falls through to it when jobsRoutes doesn't
// match a sub-path. The new KT sub-paths (/:id/accounting-check etc.) do
// not exist in jobsRoutes, so there is no route-shadowing risk.
app.use('/api/accounting', accountingRouter);
app.use('/api/jobs', accountingJobActions);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
