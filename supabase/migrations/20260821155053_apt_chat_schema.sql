create extension if not exists pgcrypto with schema extensions;

create table public.agent_instances (
  user_id uuid primary key references auth.users(id) on delete restrict,
  hermes_profile_name text not null unique check (hermes_profile_name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  hermes_session_id uuid not null unique,
  status text not null default 'ready' check (status in ('ready', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  sequence bigint generated always as identity,
  role text not null check (role in ('user', 'assistant')),
  content text not null default '',
  status text not null check (status in ('pending', 'streaming', 'completed', 'failed', 'cancelled')),
  client_message_id uuid,
  reply_to_message_id uuid,
  channel text not null default 'in_app' check (channel = 'in_app'),
  external_message_id text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint messages_user_client_message_unique unique (user_id, client_message_id),
  constraint messages_user_id_id_unique unique (user_id, id),
  constraint messages_role_fields_check check (
    (role = 'user' and client_message_id is not null and reply_to_message_id is null)
    or (role = 'assistant' and client_message_id is null and reply_to_message_id is not null)
  ),
  constraint messages_reply_owner_fk foreign key (user_id, reply_to_message_id)
    references public.messages(user_id, id) on delete restrict
);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  request_message_id uuid not null,
  response_message_id uuid not null,
  hermes_run_id text,
  status text not null default 'queued' check (status in ('queued', 'running', 'stopping', 'completed', 'failed', 'cancelled')),
  error_code text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint agent_runs_request_unique unique (request_message_id),
  constraint agent_runs_response_unique unique (response_message_id),
  constraint agent_runs_request_owner_fk foreign key (user_id, request_message_id)
    references public.messages(user_id, id) on delete restrict,
  constraint agent_runs_response_owner_fk foreign key (user_id, response_message_id)
    references public.messages(user_id, id) on delete restrict
);

create unique index agent_runs_one_active_per_user_idx
  on public.agent_runs(user_id)
  where status in ('queued', 'running', 'stopping');

create index messages_user_sequence_desc_idx on public.messages(user_id, sequence desc);
create index messages_reply_to_idx on public.messages(reply_to_message_id);
create index agent_runs_user_created_desc_idx on public.agent_runs(user_id, created_at desc);
create index agent_runs_hermes_run_id_idx on public.agent_runs(hermes_run_id) where hermes_run_id is not null;
create index agent_runs_request_message_idx on public.agent_runs(request_message_id);
create index agent_runs_response_message_idx on public.agent_runs(response_message_id);

create function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger agent_instances_set_updated_at
before update on public.agent_instances
for each row execute function public.set_updated_at();

create trigger messages_set_updated_at
before update on public.messages
for each row execute function public.set_updated_at();

alter table public.agent_instances enable row level security;
alter table public.messages enable row level security;
alter table public.agent_runs enable row level security;

alter table public.agent_instances force row level security;
alter table public.messages force row level security;
alter table public.agent_runs force row level security;

revoke all on table public.agent_instances from public, anon, authenticated;
revoke all on table public.messages from public, anon, authenticated;
revoke all on table public.agent_runs from public, anon, authenticated;
revoke all on sequence public.messages_sequence_seq from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;

grant select, insert, update, delete on table public.agent_instances to service_role;
grant select, insert, update, delete on table public.messages to service_role;
grant select, insert, update, delete on table public.agent_runs to service_role;
grant usage, select on sequence public.messages_sequence_seq to service_role;
