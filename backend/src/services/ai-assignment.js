'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = 'claude-sonnet-4-5';
const COST_INPUT_PER_M  = 3.0;
const COST_OUTPUT_PER_M = 15.0;

function getClient() {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function calcCost(usage) {
  if (!usage) return 0;
  const input  = (usage.input_tokens  / 1_000_000) * COST_INPUT_PER_M;
  const output = (usage.output_tokens / 1_000_000) * COST_OUTPUT_PER_M;
  return parseFloat((input + output).toFixed(6));
}

async function logAssignment(pool, { jobId, assignedUserId, role, reason, cost, fallback }) {
  await pool.query(
    `INSERT INTO ai_assignment_logs (job_id, assigned_user_id, role, reason, ai_cost_usd, fallback_used)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [jobId || null, assignedUserId, role, reason, cost || 0, fallback || false]
  );
}

async function getCusContext(pool, candidateIds) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const threeMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, 1).toISOString();

  const { rows: users } = await pool.query(
    `SELECT id, name, username FROM users WHERE id = ANY($1) ORDER BY username`,
    [candidateIds]
  );

  return Promise.all(users.map(async u => {
    const [monthJobs, pendingJobs, otherSvcs, recentCustomers] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS v FROM job_assignments ja
         JOIN jobs j ON j.id = ja.job_id
         WHERE ja.cus_id = $1 AND ja.assigned_at >= $2`,
        [u.id, monthStart]
      ),
      pool.query(
        `SELECT COUNT(*) AS v FROM job_assignments ja
         JOIN jobs j ON j.id = ja.job_id
         WHERE ja.cus_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL`,
        [u.id]
      ),
      pool.query(
        `SELECT COUNT(*) AS v FROM job_assignments ja
         JOIN jobs j ON j.id = ja.job_id
         WHERE ja.cus_id = $1 AND ja.assigned_at >= $2
           AND (j.other_services->>'kiem_dich' = 'true'
             OR j.other_services->>'hun_trung' = 'true'
             OR j.other_services->>'co' = 'true'
             OR j.other_services->>'dkktcl' = 'true')`,
        [u.id, monthStart]
      ),
      pool.query(
        `SELECT DISTINCT j.customer_name FROM job_assignments ja
         JOIN jobs j ON j.id = ja.job_id
         WHERE ja.cus_id = $1 AND j.created_at >= $2
         LIMIT 10`,
        [u.id, threeMonthsAgo]
      ),
    ]);

    return {
      id: u.id,
      name: u.name,
      username: u.username,
      this_month_jobs:      parseInt(monthJobs.rows[0].v),
      pending_jobs:         parseInt(pendingJobs.rows[0].v),
      other_services_month: parseInt(otherSvcs.rows[0].v),
      recent_customers:     recentCustomers.rows.map(r => r.customer_name),
    };
  }));
}

async function getOpsContext(pool, candidateIds) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const { rows: users } = await pool.query(
    `SELECT id, name, username FROM users WHERE id = ANY($1) ORDER BY username`,
    [candidateIds]
  );

  return Promise.all(users.map(async u => {
    const [monthJobs, pendingJobs, bothJobs, truckOnly, recentCustomers] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS v FROM job_assignments ja
         JOIN jobs j ON j.id = ja.job_id
         WHERE ja.ops_id = $1 AND ja.assigned_at >= $2`,
        [u.id, monthStart]
      ),
      pool.query(
        `SELECT COUNT(*) AS v FROM job_assignments ja
         JOIN jobs j ON j.id = ja.job_id
         WHERE ja.ops_id = $1 AND j.status = 'pending' AND j.deleted_at IS NULL`,
        [u.id]
      ),
      pool.query(
        `SELECT COUNT(*) AS v FROM job_assignments ja
         JOIN jobs j ON j.id = ja.job_id
         WHERE ja.ops_id = $1 AND j.service_type = 'both' AND ja.assigned_at >= $2`,
        [u.id, monthStart]
      ),
      pool.query(
        `SELECT COUNT(*) AS v FROM job_assignments ja
         JOIN jobs j ON j.id = ja.job_id
         WHERE ja.ops_id = $1 AND j.service_type = 'truck' AND ja.assigned_at >= $2`,
        [u.id, monthStart]
      ),
      pool.query(
        `SELECT DISTINCT j.customer_name FROM job_assignments ja
         JOIN jobs j ON j.id = ja.job_id
         WHERE ja.ops_id = $1 AND j.created_at >= NOW() - INTERVAL '3 months'
         LIMIT 10`,
        [u.id]
      ),
    ]);

    return {
      id: u.id,
      name: u.name,
      username: u.username,
      this_month_jobs:  parseInt(monthJobs.rows[0].v),
      pending_jobs:     parseInt(pendingJobs.rows[0].v),
      both_jobs:        parseInt(bothJobs.rows[0].v),
      truck_only_jobs:  parseInt(truckOnly.rows[0].v),
      recent_customers: recentCustomers.rows.map(r => r.customer_name),
    };
  }));
}

// Returns { user_id, user_name, reason, cost, fallback } — no DB writes
async function suggestCus(jobData, pool) {
  const { rows: candidates } = await pool.query(
    `SELECT id FROM users WHERE role IN ('cus1','cus2','cus3')`
  );
  const candidateIds = candidates.map(r => r.id);
  if (candidateIds.length === 0) throw new Error('No CUS candidates found in database');

  const context = await getCusContext(pool, candidateIds);

  const prompt = `You are an assignment system for a logistics company in Vietnam. Choose the best CUS staff member to handle a new customs declaration job.

Job details:
- Customer: ${jobData.customer_name}
- Service type: ${jobData.service_type}
- Route: ${jobData.pol || 'N/A'} → ${jobData.pod || 'N/A'}
- Other services requested: ${JSON.stringify(jobData.other_services || {})}

Staff workload:
${context.map(c => `  ${c.name} (${c.username}), id=${c.id}
  - This month jobs: ${c.this_month_jobs}
  - Currently pending: ${c.pending_jobs}
  - Other services handled this month: ${c.other_services_month}
  - Recent customers (3 months): ${c.recent_customers.slice(0, 5).join(', ') || 'none'}`).join('\n\n')}

Assignment criteria — follow this EXACT order, no exceptions:

PRIORITY 1 — WORKLOAD BALANCE (always the deciding factor):
Compute total_load = this_month_jobs + pending_jobs for each candidate.
Assign to the candidate with the LOWEST total_load. This rule overrides everything else.

PRIORITY 2 — CUSTOMER FAMILIARITY (tiebreaker ONLY, never overrides workload):
Apply ONLY IF two or more candidates have total_load values within 20% of each other
(condition: |load_A - load_B| / max(load_A, load_B) <= 0.20).
In that case, prefer the candidate listed in recent_customers for this customer.
If no workloads are within 20% of each other, IGNORE customer history and pick lowest load.

PRIORITY 3 — TASK TYPE MATCH (secondary tiebreaker):
Only if still tied after priority 2: prefer staff with higher other_services_month count.

Respond ONLY with valid JSON, no text outside the JSON object:
{"user_id": <number>, "reason": "<brief reason in Vietnamese, max 100 chars>"}`;

  try {
    const client = getClient();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });
    const cost = calcCost(response.usage);
    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found in AI response');
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.user_id || !candidateIds.includes(Number(parsed.user_id))) {
      throw new Error(`AI returned invalid user_id: ${parsed.user_id}`);
    }
    const user = context.find(c => c.id === Number(parsed.user_id));
    return { user_id: Number(parsed.user_id), user_name: user?.name, reason: parsed.reason, cost, fallback: false };
  } catch (err) {
    const sorted = [...context].sort((a, b) =>
      (a.pending_jobs + a.other_services_month) - (b.pending_jobs + b.other_services_month)
    );
    const best = sorted[0];
    const reason = `Fallback (lỗi AI: ${err.message.slice(0, 60)}): chọn người ít việc nhất`;
    return { user_id: best.id, user_name: best.name, reason, cost: 0, fallback: true };
  }
}

// assignCus = suggestCus + log to ai_assignment_logs
async function assignCus(jobData, pool) {
  const result = await suggestCus(jobData, pool);
  try {
    await logAssignment(pool, { jobId: jobData.id, assignedUserId: result.user_id, role: 'cus', reason: result.reason, cost: result.cost, fallback: result.fallback });
  } catch (e) {
    console.error('assignCus log failed:', e.message);
  }
  return result;
}

// Returns { user_id, user_name, reason, cost, fallback } or null if conditions not met — no DB writes
async function suggestOps(jobData, pool) {
  if (jobData.destination !== 'hai_phong' || !['tk', 'truck', 'both'].includes(jobData.service_type)) {
    return null;
  }

  const { rows: candidates } = await pool.query(
    `SELECT id FROM users WHERE role = 'ops'`
  );
  const candidateIds = candidates.map(r => r.id);
  if (candidateIds.length === 0) throw new Error('No OPS candidates found in database');

  const context = await getOpsContext(pool, candidateIds);

  const prompt = `You are an assignment system for a logistics company in Vietnam. Choose the best OPS staff member to handle a truck/operations job at Hải Phòng port.

Job details:
- Customer: ${jobData.customer_name}
- Service type: ${jobData.service_type}
- Destination: Hải Phòng

Staff workload:
${context.map(c => `  ${c.name} (${c.username}), id=${c.id}
  - This month jobs: ${c.this_month_jobs}
  - Currently pending: ${c.pending_jobs}
  - TK+Truck jobs this month: ${c.both_jobs}
  - Truck only jobs this month: ${c.truck_only_jobs}
  - Recent customers (3 months): ${c.recent_customers.slice(0, 5).join(', ') || 'none'}`).join('\n\n')}

Assignment criteria — follow this EXACT order, no exceptions:

PRIORITY 1 — WORKLOAD BALANCE (always the deciding factor):
Compute total_load = this_month_jobs + pending_jobs for each candidate.
Assign to the candidate with the LOWEST total_load. This rule overrides everything else.

PRIORITY 2 — CUSTOMER FAMILIARITY (tiebreaker ONLY, never overrides workload):
Apply ONLY IF two or more candidates have total_load values within 20% of each other
(condition: |load_A - load_B| / max(load_A, load_B) <= 0.20).
In that case, prefer the candidate listed in recent_customers for this customer.
If no workloads are within 20% of each other, IGNORE customer history and pick lowest load.

PRIORITY 3 — TASK TYPE MATCH (secondary tiebreaker):
Only if still tied after priority 2: prefer staff with a more balanced
TK+Truck vs Truck-only job distribution.

Respond ONLY with valid JSON, no text outside the JSON object:
{"user_id": <number>, "reason": "<brief reason in Vietnamese, max 100 chars>"}`;

  try {
    const client = getClient();
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });
    const cost = calcCost(response.usage);
    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found in AI response');
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.user_id || !candidateIds.includes(Number(parsed.user_id))) {
      throw new Error(`AI returned invalid user_id: ${parsed.user_id}`);
    }
    const user = context.find(c => c.id === Number(parsed.user_id));
    return { user_id: Number(parsed.user_id), user_name: user?.name, reason: parsed.reason, cost, fallback: false };
  } catch (err) {
    const sorted = [...context].sort((a, b) => a.this_month_jobs - b.this_month_jobs);
    const best = sorted[0];
    const reason = `Fallback (lỗi AI: ${err.message.slice(0, 60)}): chọn người ít việc nhất tháng này`;
    return { user_id: best.id, user_name: best.name, reason, cost: 0, fallback: true };
  }
}

// assignOps = suggestOps + log to ai_assignment_logs
async function assignOps(jobData, pool) {
  const result = await suggestOps(jobData, pool);
  if (!result) return null;
  try {
    await logAssignment(pool, { jobId: jobData.id, assignedUserId: result.user_id, role: 'ops', reason: result.reason, cost: result.cost, fallback: result.fallback });
  } catch (e) {
    console.error('assignOps log failed:', e.message);
  }
  return result;
}

module.exports = { assignCus, assignOps, suggestCus, suggestOps };
