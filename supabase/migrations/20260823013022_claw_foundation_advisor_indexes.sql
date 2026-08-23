-- Cover the two composite/sparse foreign keys identified by the post-deploy
-- Supabase performance advisor. New-table unused-index notices are expected.
create index claw_admins_granted_by_idx
  on public.claw_admins(granted_by)
  where granted_by is not null;

create index commerce_hunts_run_owner_idx
  on public.commerce_hunts(user_id, agent_run_id);
