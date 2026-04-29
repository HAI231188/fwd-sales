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
