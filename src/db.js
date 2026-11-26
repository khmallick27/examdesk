const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || 'postgres://examdesk:examdesk@localhost:5432/examdesk';
// Supabase / managed Postgres require TLS; local dev does not.
const ssl = /localhost|127\.0\.0\.1/.test(url) || process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false };
const pool = new Pool({ connectionString: url, ssl, max: Number(process.env.PG_POOL_MAX || 10) });

async function migrate() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
}

async function audit(actor, action, detail = '', ip = null) {
  await pool.query('INSERT INTO audit_log(actor, action, detail, ip) VALUES ($1,$2,$3,$4)', [actor, action, String(detail).slice(0, 2000), ip]);
}

module.exports = { pool, migrate, audit, q: (text, params) => pool.query(text, params) };
