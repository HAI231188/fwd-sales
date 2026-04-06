require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const db = require('./index');

async function seed() {
  const seedSQL = fs.readFileSync(path.join(__dirname, 'seed.sql'), 'utf8');
  try {
    await db.query(seedSQL);
    console.log('✅ Database seeded successfully');
  } catch (err) {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  } finally {
    await db.pool.end();
  }
}

seed();
