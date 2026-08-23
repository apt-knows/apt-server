import { Pool } from 'pg';
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { argument } from './cli.js';

const founderId = z.uuid().parse(argument('--user-id'));
const grantedBy = z.uuid().parse(argument('--granted-by', false) ?? founderId);
const config = loadConfig();
const pool = new Pool({
  connectionString: config.supabase.databaseUrl,
  max: 1,
  ssl: config.supabase.databaseSsl ? { rejectUnauthorized: false } : undefined,
});
try {
  await pool.query(
    `insert into public.claw_admins(user_id, granted_by) values ($1, $2)
     on conflict (user_id) do update set granted_by = excluded.granted_by`,
    [founderId, grantedBy],
  );
  process.stdout.write(`Granted founder Claw access to ${founderId}.\n`);
} finally { await pool.end(); }

