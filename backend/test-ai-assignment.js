'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const { assignCus, assignOps } = require('./src/services/ai-assignment');

// Accept public DB URL as CLI arg: node test-ai-assignment.js postgresql://...
// Required when running locally — Railway's DATABASE_URL uses internal hostname unreachable outside their network
const dbUrl = process.argv[2] || process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!dbUrl) { console.error('No database URL. Pass it as first argument or set DATABASE_PUBLIC_URL'); process.exit(1); }
const pool = new Pool({ connectionString: dbUrl });

const dummyJob = {
  id: null,
  customer_name: 'Công ty TNHH TEST ABC',
  service_type: 'both',
  pol: 'HAN',
  pod: 'SIN',
  destination: 'hai_phong',
  other_services: { kiem_dich: true },
};

function printResult(label, result) {
  console.log(`\n--- ${label} ---`);
  if (!result) {
    console.log('  Result: null (conditions not met for this function)');
    return;
  }
  console.log(`  user_id  : ${result.user_id}`);
  console.log(`  reason   : ${result.reason}`);
  console.log(`  cost_usd : $${result.cost}`);
  console.log(`  fallback : ${result.fallback}`);
}

async function main() {
  console.log('Testing AI assignment module...');
  console.log('Dummy job:', JSON.stringify(dummyJob, null, 2));

  try {
    const cusResult = await assignCus(dummyJob, pool);
    printResult('assignCus', cusResult);
  } catch (err) {
    console.error('\n--- assignCus FAILED ---');
    console.error(' ', err.message);
  }

  try {
    const opsResult = await assignOps(dummyJob, pool);
    printResult('assignOps', opsResult);
  } catch (err) {
    console.error('\n--- assignOps FAILED ---');
    console.error(' ', err.message);
  }

  await pool.end();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
