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

if (!fs.existsSync(frontendDist)) {
  console.log('🔨 frontend/dist not found — building frontend...');
  execSync('npm install && npm run build', {
    cwd: frontendDir,
    stdio: 'inherit',
  });
  console.log('✅ Frontend built successfully');
} else {
  console.log('📁 frontend/dist found — skipping build');
}

require('./server');
