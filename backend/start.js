/**
 * Production entry point.
 * Builds the frontend if dist is missing, then starts the Express server.
 */
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const frontendDir = path.join(__dirname, '../frontend');
const frontendDist = path.join(frontendDir, 'dist');

// Run DB migrations (schema uses IF NOT EXISTS — safe to run every deploy)
console.log('🗄️  Running database migrations...');
try {
  execSync('node src/db/migrate.js', { cwd: __dirname, stdio: 'inherit' });
} catch (e) {
  console.warn('⚠️  Migration warning (server will still start):', e.message);
}

// Seed sales/lead users (idempotent — ON CONFLICT DO UPDATE, passwords not overwritten)
console.log('👤 Seeding users...');
try {
  execSync('node src/db/seed_users.js', { cwd: __dirname, stdio: 'inherit' });
} catch (e) {
  console.warn('⚠️  Seed warning (server will still start):', e.message);
}

// Backfill pipeline from existing report data (idempotent — safe every deploy)
console.log('🔄 Backfilling pipeline from existing customers...');
try {
  execSync('node src/db/backfill_pipeline.js', { cwd: __dirname, stdio: 'inherit' });
} catch (e) {
  console.warn('⚠️  Backfill warning (server will still start):', e.message);
}

console.log('🔨 Building frontend...');
execSync('npm install && npm run build', {
  cwd: frontendDir,
  stdio: 'inherit',
});
console.log('✅ Frontend built successfully');

require('./server');
