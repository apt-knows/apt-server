import { Pool } from 'pg';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { argument } from './cli.js';

const founderId = z.uuid().parse(argument('--user-id'));
const confirmation = argument('--confirm');
if (confirmation !== founderId) throw new Error('Revocation requires --confirm to exactly match the founder UUID.');
const config = loadConfig();
const pool = new Pool({
  connectionString: config.supabase.databaseUrl,
  max: 1,
  ssl: config.supabase.databaseSsl ? { rejectUnauthorized: false } : undefined,
});
try {
  await pool.query('delete from public.claw_admins where user_id = $1', [founderId]);
  process.stdout.write(`Revoked founder Claw access from ${founderId}.\n`);
} finally { await pool.end(); }

