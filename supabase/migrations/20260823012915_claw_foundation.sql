-- APT-8 Claw foundation. Live prompt/artifact content is intentionally absent:
-- Supabase rows authored through the founder console are the runtime source.

alter table public.agent_runs
  add constraint agent_runs_user_id_id_unique unique (user_id, id);

create table public.claw_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  granted_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.claw_releases (
  id uuid primary key default gen_random_uuid(),
  version integer not null unique check (version > 0),
  name text not null check (char_length(btrim(name)) between 1 and 160),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  base_release_id uuid references public.claw_releases(id) on delete restrict,
  change_note text not null default '' check (char_length(change_note) <= 2000),
  created_by uuid not null references auth.users(id) on delete restrict,
  published_by uuid references auth.users(id) on delete restrict,
  revision bigint not null default 1 check (revision > 0),
  content_checksum text,
  validation_result jsonb not null default '{}'::jsonb check (jsonb_typeof(validation_result) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  constraint claw_releases_publish_fields_check check (
    (status = 'published' and published_by is not null and published_at is not null and content_checksum ~ '^[a-f0-9]{64}$')
    or status <> 'published'
  )
);

create unique index claw_releases_one_published_idx
  on public.claw_releases ((true)) where status = 'published';
create index claw_releases_base_release_idx on public.claw_releases(base_release_id) where base_release_id is not null;
create index claw_releases_created_by_idx on public.claw_releases(created_by);
create index claw_releases_published_by_idx on public.claw_releases(published_by) where published_by is not null;

create table public.claw_documents (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.claw_releases(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  kind text not null check (kind in ('core', 'soul_template', 'policy', 'intent', 'merchant', 'skill')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  content text not null check (char_length(content) between 1 and 100000),
  enabled boolean not null default true,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint claw_documents_release_key_unique unique (release_id, key)
);

create index claw_documents_release_kind_enabled_idx on public.claw_documents(release_id, kind, enabled);

create table public.claw_capabilities (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.claw_releases(id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_.-]{0,127}$'),
  kind text not null check (kind in ('toolset', 'mcp')),
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  instructions text not null default '' check (char_length(instructions) <= 20000),
  secret_refs text[] not null default '{}'::text[] check (
    array_to_string(secret_refs, ',') = ''
    or array_to_string(secret_refs, ',') ~ '^[A-Z][A-Z0-9_]*(,[A-Z][A-Z0-9_]*)*$'
  ),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint claw_capabilities_release_key_unique unique (release_id, key)
);

create index claw_capabilities_release_kind_enabled_idx on public.claw_capabilities(release_id, kind, enabled);

create table public.claw_user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  soul_text text not null default '' check (char_length(soul_text) <= 20000),
  hot_user_text text not null default '' check (char_length(hot_user_text) <= 1375),
  hot_memory_text text not null default '' check (char_length(hot_memory_text) <= 2200),
  revision bigint not null default 1 check (revision > 0),
  knowledge_revision bigint not null default 0 check (knowledge_revision >= 0),
  runtime_hash text check (runtime_hash is null or runtime_hash ~ '^[a-f0-9]{64}$'),
  last_learning_at timestamptz,
  last_reconciled_at timestamptz,
  reconciliation_error text check (char_length(reconciliation_error) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.claw_user_knowledge (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject_kind text not null check (subject_kind in ('self', 'recipient', 'relationship', 'other')),
  subject_label text check (subject_label is null or char_length(btrim(subject_label)) between 1 and 160),
  category text not null check (category ~ '^[a-z][a-z0-9_.-]{0,63}$'),
  fact text not null check (char_length(btrim(fact)) between 1 and 4000),
  confidence numeric(4,3) not null check (confidence between 0 and 1),
  sensitivity text not null default 'low' check (sensitivity in ('low', 'sensitive')),
  status text not null default 'active' check (status in ('active', 'forgotten', 'superseded', 'expired')),
  source_message_id uuid,
  source_agent_run_id uuid,
  learned_at timestamptz not null default now(),
  last_confirmed_at timestamptz,
  expires_at timestamptz,
  superseded_by uuid references public.claw_user_knowledge(id) on delete set null,
  search_document tsvector generated always as (
    to_tsvector(
      'english'::regconfig,
      coalesce(subject_label, '') || ' ' || category || ' ' || fact
    )
  ) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint claw_user_knowledge_source_message_owner_fk foreign key (user_id, source_message_id)
    references public.messages(user_id, id) on delete set null (source_message_id),
  constraint claw_user_knowledge_source_run_owner_fk foreign key (user_id, source_agent_run_id)
    references public.agent_runs(user_id, id) on delete set null (source_agent_run_id),
  constraint claw_user_knowledge_subject_check check (
    (subject_kind = 'self' and subject_label is null)
    or (subject_kind <> 'self' and subject_label is not null)
  ),
  constraint claw_user_knowledge_superseded_status_check check (
    (status = 'superseded' and superseded_by is not null)
    or status <> 'superseded'
  )
);

create index claw_user_knowledge_search_idx on public.claw_user_knowledge using gin(search_document);
create index claw_user_knowledge_active_user_category_idx
  on public.claw_user_knowledge(user_id, category, subject_kind, subject_label)
  where status = 'active';
create index claw_user_knowledge_active_expiry_idx
  on public.claw_user_knowledge(user_id, expires_at)
  where status = 'active' and expires_at is not null;
create index claw_user_knowledge_source_message_idx
  on public.claw_user_knowledge(user_id, source_message_id) where source_message_id is not null;
create index claw_user_knowledge_source_run_idx
  on public.claw_user_knowledge(user_id, source_agent_run_id) where source_agent_run_id is not null;
create index claw_user_knowledge_superseded_by_idx
  on public.claw_user_knowledge(superseded_by) where superseded_by is not null;

create table public.claw_user_skills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null check (key ~ '^private\.[a-z0-9][a-z0-9_.-]{0,116}$'),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  content text not null check (char_length(content) between 1 and 40000),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  status text not null default 'active' check (status in ('active', 'archived')),
  revision bigint not null default 1 check (revision > 0),
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  source_agent_run_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint claw_user_skills_user_key_unique unique (user_id, key),
  constraint claw_user_skills_source_run_owner_fk foreign key (user_id, source_agent_run_id)
    references public.agent_runs(user_id, id) on delete set null (source_agent_run_id)
);

create index claw_user_skills_active_user_idx on public.claw_user_skills(user_id, key) where status = 'active';
create index claw_user_skills_source_run_idx on public.claw_user_skills(user_id, source_agent_run_id) where source_agent_run_id is not null;

create table public.claw_learning_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_run_id uuid,
  source_message_id uuid,
  artifact_kind text not null check (artifact_kind in ('knowledge', 'user_profile', 'memory', 'soul', 'private_skill')),
  action text not null check (action in ('add', 'replace', 'remove', 'forget', 'expire', 'reconcile')),
  artifact_id uuid,
  before_value jsonb,
  after_value jsonb,
  created_at timestamptz not null default now(),
  constraint claw_learning_events_run_owner_fk foreign key (user_id, agent_run_id)
    references public.agent_runs(user_id, id) on delete set null (agent_run_id),
  constraint claw_learning_events_message_owner_fk foreign key (user_id, source_message_id)
    references public.messages(user_id, id) on delete set null (source_message_id)
);

create index claw_learning_events_user_created_idx on public.claw_learning_events(user_id, created_at desc);
create index claw_learning_events_run_idx on public.claw_learning_events(user_id, agent_run_id) where agent_run_id is not null;
create index claw_learning_events_message_idx on public.claw_learning_events(user_id, source_message_id) where source_message_id is not null;

create table public.claw_learning_proposals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  kind text not null check (kind in ('core', 'soul_template', 'skill', 'policy', 'merchant', 'intent', 'tool', 'mcp')),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  rationale text not null check (char_length(btrim(rationale)) between 1 and 4000),
  content text not null check (char_length(btrim(content)) between 1 and 50000),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'rejected')),
  reviewed_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  constraint claw_learning_proposals_review_check check (
    (status = 'pending' and reviewed_by is null and reviewed_at is null)
    or (status <> 'pending' and reviewed_by is not null and reviewed_at is not null)
  )
);

create index claw_learning_proposals_pending_idx on public.claw_learning_proposals(created_at) where status = 'pending';
create index claw_learning_proposals_user_idx on public.claw_learning_proposals(user_id) where user_id is not null;
create index claw_learning_proposals_run_idx on public.claw_learning_proposals(agent_run_id) where agent_run_id is not null;
create index claw_learning_proposals_reviewer_idx on public.claw_learning_proposals(reviewed_by) where reviewed_by is not null;

-- Match the application compiler's recursively sorted, whitespace-free JSON
-- representation so capability checksums can be independently verified in SQL.
create function public.claw_stable_json(p_value jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select case jsonb_typeof(p_value)
    when 'object' then '{' || coalesce((
      select string_agg(to_jsonb(entry.key)::text || ':' || public.claw_stable_json(entry.value), ',' order by entry.key)
      from jsonb_each(p_value) entry
    ), '') || '}'
    when 'array' then '[' || coalesce((
      select string_agg(public.claw_stable_json(entry.value), ',' order by entry.ordinality)
      from jsonb_array_elements(p_value) with ordinality entry(value, ordinality)
    ), '') || ']'
    when 'number' then trim_scale((p_value #>> '{}')::numeric)::text
    else p_value::text
  end
$$;

create table public.commerce_hunts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  agent_run_id uuid not null unique,
  request_message_id uuid not null,
  category text not null check (category in ('retail', 'grocery', 'food')),
  status text not null default 'running' check (status in ('running', 'completed', 'failed', 'cancelled')),
  query jsonb not null default '{}'::jsonb check (jsonb_typeof(query) = 'object'),
  constraints jsonb not null default '{}'::jsonb check (jsonb_typeof(constraints) = 'object'),
  coarse_location_label text check (coarse_location_label is null or char_length(coarse_location_label) <= 160),
  candidates jsonb not null default '[]'::jsonb check (jsonb_typeof(candidates) = 'array'),
  source_urls jsonb not null default '[]'::jsonb check (jsonb_typeof(source_urls) = 'array'),
  search_document tsvector generated always as (
    jsonb_to_tsvector('english'::regconfig, query || constraints || candidates, '["string"]'::jsonb)
  ) stored,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint commerce_hunts_run_owner_fk foreign key (user_id, agent_run_id)
    references public.agent_runs(user_id, id) on delete cascade,
  constraint commerce_hunts_request_owner_fk foreign key (user_id, request_message_id)
    references public.messages(user_id, id) on delete restrict,
  constraint commerce_hunts_terminal_check check (
    (status = 'running' and completed_at is null)
    or (status <> 'running' and completed_at is not null)
  )
);

create index commerce_hunts_user_created_idx on public.commerce_hunts(user_id, created_at desc);
create index commerce_hunts_user_category_created_idx on public.commerce_hunts(user_id, category, created_at desc);
create index commerce_hunts_request_idx on public.commerce_hunts(user_id, request_message_id);
create index commerce_hunts_search_idx on public.commerce_hunts using gin(search_document);

alter table public.agent_runs
  add column claw_release_id uuid references public.claw_releases(id) on delete restrict,
  add column claw_release_checksum text check (claw_release_checksum is null or claw_release_checksum ~ '^[a-f0-9]{64}$'),
  add column claw_mode text check (claw_mode is null or claw_mode in ('reply', 'hunt')),
  add column claw_profile_revision bigint check (claw_profile_revision is null or claw_profile_revision > 0),
  add column claw_knowledge_revision bigint check (claw_knowledge_revision is null or claw_knowledge_revision >= 0);

create index agent_runs_claw_release_idx on public.agent_runs(claw_release_id) where claw_release_id is not null;

create function public.claw_guard_release_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  publishing boolean := current_setting('apt.claw_publish', true) = 'on';
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Published Claw release history is immutable.' using errcode = '55000';
    end if;
    return old;
  end if;

  if old.status = 'archived' then
    raise exception 'Archived Claw releases are immutable.' using errcode = '55000';
  end if;

  if old.status = 'published' then
    if not publishing or new.status <> 'archived'
      or new.id <> old.id
      or new.version <> old.version
      or new.name <> old.name
      or new.base_release_id is distinct from old.base_release_id
      or new.change_note <> old.change_note
      or new.created_by <> old.created_by
      or new.published_by is distinct from old.published_by
      or new.revision <> old.revision
      or new.content_checksum is distinct from old.content_checksum
      or new.validation_result <> old.validation_result
      or new.created_at <> old.created_at
      or new.published_at is distinct from old.published_at then
      raise exception 'Published Claw releases are immutable except for atomic archival.' using errcode = '55000';
    end if;
    return new;
  end if;

  if new.status <> 'draft' and not publishing then
    raise exception 'Use the atomic Claw publish operation.' using errcode = '55000';
  end if;
  return new;
end;
$$;

create trigger claw_releases_guard_mutation
before update or delete on public.claw_releases
for each row execute function public.claw_guard_release_mutation();

create function public.claw_guard_release_artifact_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_release_id uuid := case when tg_op = 'DELETE' then old.release_id else new.release_id end;
  selected_status text;
  previous_status text;
begin
  select status into selected_status from public.claw_releases where id = selected_release_id;
  if selected_status is distinct from 'draft' then
    raise exception 'Artifacts belonging to a non-draft Claw release are immutable.' using errcode = '55000';
  end if;
  if tg_op = 'UPDATE' then
    select status into previous_status from public.claw_releases where id = old.release_id;
    if previous_status is distinct from 'draft' then
      raise exception 'Artifacts cannot be moved out of a non-draft Claw release.' using errcode = '55000';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

create trigger claw_documents_guard_mutation
before insert or update or delete on public.claw_documents
for each row execute function public.claw_guard_release_artifact_mutation();

create trigger claw_capabilities_guard_mutation
before insert or update or delete on public.claw_capabilities
for each row execute function public.claw_guard_release_artifact_mutation();

create function public.claw_clone_release(
  p_source_release_id uuid,
  p_founder_id uuid,
  p_release_name text,
  p_release_change_note text default ''
)
returns public.claw_releases
language plpgsql
security invoker
set search_path = ''
as $$
declare
  source_release public.claw_releases;
  cloned_release public.claw_releases;
  next_version integer;
begin
  if not exists (select 1 from public.claw_admins where user_id = p_founder_id) then
    raise exception 'Founder authorization is required.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('apt-claw-release'));
  select * into source_release from public.claw_releases where id = p_source_release_id;
  if not found then raise exception 'Source Claw release not found.' using errcode = 'P0002'; end if;
  select coalesce(max(version), 0) + 1 into next_version from public.claw_releases;
  insert into public.claw_releases(version, name, status, base_release_id, change_note, created_by)
  values (next_version, btrim(p_release_name), 'draft', source_release.id, coalesce(p_release_change_note, ''), p_founder_id)
  returning * into cloned_release;

  insert into public.claw_documents(release_id, key, kind, title, content, enabled, metadata, checksum)
  select cloned_release.id, key, kind, title, content, enabled, metadata, checksum
  from public.claw_documents where release_id = source_release.id;

  insert into public.claw_capabilities(release_id, key, kind, enabled, config, instructions, secret_refs, checksum)
  select cloned_release.id, key, kind, enabled, config, instructions, secret_refs, checksum
  from public.claw_capabilities where release_id = source_release.id;

  return cloned_release;
end;
$$;

create function public.claw_create_release(
  p_founder_id uuid,
  p_release_name text,
  p_change_note text default ''
)
returns public.claw_releases
language plpgsql
security invoker
set search_path = ''
as $$
declare
  created_release public.claw_releases;
  next_version integer;
begin
  if not exists (select 1 from public.claw_admins where user_id = p_founder_id) then
    raise exception 'Founder authorization is required.' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('apt-claw-release'));
  select coalesce(max(version), 0) + 1 into next_version from public.claw_releases;
  insert into public.claw_releases(version, name, status, change_note, created_by)
  values (next_version, btrim(p_release_name), 'draft', coalesce(p_change_note, ''), p_founder_id)
  returning * into created_release;
  return created_release;
end;
$$;

create function public.claw_save_document(
  p_founder_id uuid,
  p_release_id uuid,
  p_expected_revision bigint,
  p_key text,
  p_kind text,
  p_title text,
  p_content text,
  p_enabled boolean,
  p_metadata jsonb,
  p_checksum text
)
returns public.claw_releases
language plpgsql
security invoker
set search_path = ''
as $$
declare
  updated_release public.claw_releases;
begin
  if not exists (select 1 from public.claw_admins where user_id = p_founder_id) then
    raise exception 'Founder authorization is required.' using errcode = '42501';
  end if;
  if p_checksum <> encode(extensions.digest(p_content, 'sha256'), 'hex') then
    raise exception 'Document checksum does not match its content.' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtext('apt-claw-release'));
  if not exists (
    select 1 from public.claw_releases
    where id = p_release_id and status = 'draft' and revision = p_expected_revision for update
  ) then
    raise exception 'Draft revision conflict.' using errcode = '40001';
  end if;
  insert into public.claw_documents(release_id, key, kind, title, content, enabled, metadata, checksum)
  values (p_release_id, p_key, p_kind, p_title, p_content, p_enabled, coalesce(p_metadata, '{}'::jsonb), p_checksum)
  on conflict (release_id, key) do update
  set kind = excluded.kind, title = excluded.title, content = excluded.content,
      enabled = excluded.enabled, metadata = excluded.metadata, checksum = excluded.checksum;
  update public.claw_releases set revision = revision + 1
  where id = p_release_id returning * into updated_release;
  return updated_release;
end;
$$;

create function public.claw_save_capability(
  p_founder_id uuid,
  p_release_id uuid,
  p_expected_revision bigint,
  p_key text,
  p_kind text,
  p_enabled boolean,
  p_config jsonb,
  p_instructions text,
  p_secret_refs text[],
  p_checksum text
)
returns public.claw_releases
language plpgsql
security invoker
set search_path = ''
as $$
declare
  updated_release public.claw_releases;
  calculated_checksum text;
begin
  if not exists (select 1 from public.claw_admins where user_id = p_founder_id) then
    raise exception 'Founder authorization is required.' using errcode = '42501';
  end if;
  if p_key not in ('memory', 'session_search', 'skills', 'apt_bridge') then
    raise exception 'Capability is outside the code-approved allowlist.' using errcode = '23514';
  end if;
  calculated_checksum := encode(extensions.digest(public.claw_stable_json(jsonb_build_object(
    'key', p_key,
    'kind', p_kind,
    'enabled', p_enabled,
    'config', coalesce(p_config, '{}'::jsonb),
    'instructions', coalesce(p_instructions, ''),
    'secretRefs', to_jsonb(coalesce(p_secret_refs, '{}'::text[]))
  )), 'sha256'), 'hex');
  if p_checksum <> calculated_checksum then
    raise exception 'Capability checksum does not match its content.' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtext('apt-claw-release'));
  if not exists (
    select 1 from public.claw_releases
    where id = p_release_id and status = 'draft' and revision = p_expected_revision for update
  ) then
    raise exception 'Draft revision conflict.' using errcode = '40001';
  end if;
  insert into public.claw_capabilities(release_id, key, kind, enabled, config, instructions, secret_refs, checksum)
  values (p_release_id, p_key, p_kind, p_enabled, coalesce(p_config, '{}'::jsonb), coalesce(p_instructions, ''), coalesce(p_secret_refs, '{}'::text[]), p_checksum)
  on conflict (release_id, key) do update
  set kind = excluded.kind, enabled = excluded.enabled, config = excluded.config,
      instructions = excluded.instructions, secret_refs = excluded.secret_refs, checksum = excluded.checksum;
  update public.claw_releases set revision = revision + 1
  where id = p_release_id returning * into updated_release;
  return updated_release;
end;
$$;

create function public.claw_review_proposal(
  p_founder_id uuid,
  p_proposal_id uuid,
  p_decision text,
  p_release_id uuid default null,
  p_expected_revision bigint default null,
  p_target_key text default null
)
returns public.claw_learning_proposals
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_proposal public.claw_learning_proposals;
  reviewed_proposal public.claw_learning_proposals;
  proposal_checksum text;
begin
  if not exists (select 1 from public.claw_admins where user_id = p_founder_id) then
    raise exception 'Founder authorization is required.' using errcode = '42501';
  end if;
  if p_decision not in ('accepted', 'rejected') then
    raise exception 'Proposal decision must be accepted or rejected.' using errcode = '22023';
  end if;
  select * into selected_proposal from public.claw_learning_proposals
  where id = p_proposal_id and status = 'pending' for update;
  if not found then raise exception 'Pending proposal not found.' using errcode = 'P0002'; end if;
  if p_decision = 'accepted' then
    if p_release_id is null or p_expected_revision is null or p_target_key is null then
      raise exception 'Merging requires a target draft, revision, and key.' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtext('apt-claw-release'));
    if not exists (
      select 1 from public.claw_releases
      where id = p_release_id and status = 'draft' and revision = p_expected_revision for update
    ) then
      raise exception 'Draft revision conflict.' using errcode = '40001';
    end if;
    if selected_proposal.kind in ('tool', 'mcp') then
      if p_target_key not in ('memory', 'session_search', 'skills', 'apt_bridge') then
        raise exception 'Proposed capability is outside the code-approved allowlist.' using errcode = '23514';
      end if;
      proposal_checksum := encode(extensions.digest(public.claw_stable_json(jsonb_build_object(
        'key', p_target_key,
        'kind', case when selected_proposal.kind = 'mcp' then 'mcp' else 'toolset' end,
        'enabled', false,
        'config', '{}'::jsonb,
        'instructions', selected_proposal.content,
        'secretRefs', '[]'::jsonb
      )), 'sha256'), 'hex');
      insert into public.claw_capabilities(release_id, key, kind, enabled, config, instructions, secret_refs, checksum)
      values (p_release_id, p_target_key, case when selected_proposal.kind = 'mcp' then 'mcp' else 'toolset' end,
              false, '{}'::jsonb, selected_proposal.content, '{}'::text[], proposal_checksum)
      on conflict (release_id, key) do update
      set kind = excluded.kind, enabled = false, config = '{}'::jsonb,
          instructions = excluded.instructions, secret_refs = '{}'::text[], checksum = excluded.checksum;
    else
      proposal_checksum := encode(extensions.digest(selected_proposal.content, 'sha256'), 'hex');
      insert into public.claw_documents(release_id, key, kind, title, content, enabled, checksum)
      values (p_release_id, p_target_key, selected_proposal.kind, selected_proposal.title,
              selected_proposal.content, true, proposal_checksum)
      on conflict (release_id, key) do update
      set kind = excluded.kind, title = excluded.title, content = excluded.content, checksum = excluded.checksum;
    end if;
    update public.claw_releases set revision = revision + 1 where id = p_release_id;
  end if;
  update public.claw_learning_proposals
  set status = p_decision, reviewed_by = p_founder_id, reviewed_at = now()
  where id = p_proposal_id returning * into reviewed_proposal;
  return reviewed_proposal;
end;
$$;

create function public.claw_publish_release(
  p_release_id uuid,
  p_founder_id uuid,
  p_expected_revision bigint,
  p_publish_change_note text
)
returns public.claw_releases
language plpgsql
security invoker
set search_path = ''
as $$
declare
  selected_release public.claw_releases;
  published_release public.claw_releases;
  calculated_checksum text;
  validation jsonb;
begin
  if not exists (select 1 from public.claw_admins where user_id = p_founder_id) then
    raise exception 'Founder authorization is required.' using errcode = '42501';
  end if;
  if char_length(btrim(coalesce(p_publish_change_note, ''))) = 0 then
    raise exception 'A publish change note is required.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('apt-claw-release'));
  select * into selected_release from public.claw_releases where id = p_release_id for update;
  if not found then raise exception 'Claw release not found.' using errcode = 'P0002'; end if;
  if selected_release.status <> 'draft' then raise exception 'Only a draft can be published.' using errcode = '55000'; end if;
  if selected_release.revision <> p_expected_revision then raise exception 'Draft revision conflict.' using errcode = '40001'; end if;

  if not exists (select 1 from public.claw_documents d where d.release_id = p_release_id and d.kind = 'core' and d.enabled)
    or not exists (select 1 from public.claw_documents d where d.release_id = p_release_id and d.kind = 'soul_template' and d.enabled)
    or not exists (select 1 from public.claw_documents d where d.release_id = p_release_id and d.kind = 'policy' and d.enabled)
    or not exists (select 1 from public.claw_documents d where d.release_id = p_release_id and d.key = 'intent.retail' and d.kind = 'intent' and d.enabled)
    or not exists (select 1 from public.claw_documents d where d.release_id = p_release_id and d.key = 'intent.grocery' and d.kind = 'intent' and d.enabled)
    or not exists (select 1 from public.claw_documents d where d.release_id = p_release_id and d.key = 'intent.food' and d.kind = 'intent' and d.enabled) then
    raise exception 'Draft is missing required core, Soul, policy, or vertical intent documents.' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.claw_documents d
    where d.release_id = p_release_id
      and d.checksum <> encode(extensions.digest(d.content, 'sha256'), 'hex')
  ) then
    raise exception 'Draft contains a document checksum mismatch.' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.claw_documents d
    where d.release_id = p_release_id and d.enabled and d.kind = 'skill'
      and (
        char_length(d.content) > 40000
        or replace(d.content, E'\r', '') !~ '(?s)^---\n.*\n---(\n|$)'
        or replace(d.content, E'\r', '') !~ '(?m)^description:\s*.+$'
        or btrim((regexp_match(replace(d.content, E'\r', ''), '(?m)^name:\s*["'']?([^"''\n]+)["'']?\s*$'))[1]) is distinct from d.key
      )
  ) then
    raise exception 'Draft contains an invalid shared skill document.' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.claw_capabilities
    where claw_capabilities.release_id = p_release_id and enabled and key not in ('memory', 'session_search', 'skills', 'apt_bridge')
  ) or exists (
    select 1 from public.claw_capabilities
    where claw_capabilities.release_id = p_release_id and enabled and kind = 'mcp' and key <> 'apt_bridge'
  ) then
    raise exception 'Draft enables a capability outside the code-approved allowlist.' using errcode = '23514';
  end if;

  if not exists (select 1 from public.claw_capabilities c where c.release_id = p_release_id and c.key = 'apt_bridge' and c.kind = 'mcp' and c.enabled)
    or not exists (select 1 from public.claw_capabilities c where c.release_id = p_release_id and c.key = 'memory' and c.kind = 'toolset' and c.enabled)
    or not exists (select 1 from public.claw_capabilities c where c.release_id = p_release_id and c.key = 'session_search' and c.kind = 'toolset' and c.enabled)
    or not exists (select 1 from public.claw_capabilities c where c.release_id = p_release_id and c.key = 'skills' and c.kind = 'toolset' and c.enabled) then
    raise exception 'Draft must enable the Apt bridge and narrow memory/session-search/skills toolsets.' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.claw_capabilities c
    where c.release_id = p_release_id
      and c.checksum <> encode(extensions.digest(public.claw_stable_json(jsonb_build_object(
        'key', c.key,
        'kind', c.kind,
        'enabled', c.enabled,
        'config', c.config,
        'instructions', c.instructions,
        'secretRefs', to_jsonb(c.secret_refs)
      )), 'sha256'), 'hex')
  ) then
    raise exception 'Draft contains a capability checksum mismatch.' using errcode = '23514';
  end if;

  select encode(
    extensions.digest(
      coalesce((select string_agg('d|' || key || '|' || checksum || '|' || enabled::text, E'\n' order by key)
                from public.claw_documents d where d.release_id = p_release_id), '') || E'\n' ||
      coalesce((select string_agg('c|' || key || '|' || checksum || '|' || enabled::text, E'\n' order by key)
                from public.claw_capabilities c where c.release_id = p_release_id), ''),
      'sha256'
    ),
    'hex'
  ) into calculated_checksum;

  validation := jsonb_build_object(
    'valid', true,
    'validated_at', now(),
    'document_count', (select count(*) from public.claw_documents d where d.release_id = p_release_id),
    'capability_count', (select count(*) from public.claw_capabilities c where c.release_id = p_release_id)
  );

  perform set_config('apt.claw_publish', 'on', true);
  update public.claw_releases set status = 'archived', updated_at = now() where status = 'published';
  update public.claw_releases
  set status = 'published', change_note = btrim(p_publish_change_note), published_by = p_founder_id,
      published_at = now(), updated_at = now(), content_checksum = calculated_checksum,
      validation_result = validation
  where id = p_release_id
  returning * into published_release;
  return published_release;
end;
$$;

create trigger claw_releases_set_updated_at
before update on public.claw_releases
for each row execute function public.set_updated_at();
create trigger claw_documents_set_updated_at
before update on public.claw_documents
for each row execute function public.set_updated_at();
create trigger claw_capabilities_set_updated_at
before update on public.claw_capabilities
for each row execute function public.set_updated_at();
create trigger claw_user_profiles_set_updated_at
before update on public.claw_user_profiles
for each row execute function public.set_updated_at();
create trigger claw_user_knowledge_set_updated_at
before update on public.claw_user_knowledge
for each row execute function public.set_updated_at();
create trigger claw_user_skills_set_updated_at
before update on public.claw_user_skills
for each row execute function public.set_updated_at();

alter table public.claw_admins enable row level security;
alter table public.claw_releases enable row level security;
alter table public.claw_documents enable row level security;
alter table public.claw_capabilities enable row level security;
alter table public.claw_user_profiles enable row level security;
alter table public.claw_user_knowledge enable row level security;
alter table public.claw_user_skills enable row level security;
alter table public.claw_learning_events enable row level security;
alter table public.claw_learning_proposals enable row level security;
alter table public.commerce_hunts enable row level security;

alter table public.claw_admins force row level security;
alter table public.claw_releases force row level security;
alter table public.claw_documents force row level security;
alter table public.claw_capabilities force row level security;
alter table public.claw_user_profiles force row level security;
alter table public.claw_user_knowledge force row level security;
alter table public.claw_user_skills force row level security;
alter table public.claw_learning_events force row level security;
alter table public.claw_learning_proposals force row level security;
alter table public.commerce_hunts force row level security;

revoke all on table public.claw_admins from public, anon, authenticated;
revoke all on table public.claw_releases from public, anon, authenticated;
revoke all on table public.claw_documents from public, anon, authenticated;
revoke all on table public.claw_capabilities from public, anon, authenticated;
revoke all on table public.claw_user_profiles from public, anon, authenticated;
revoke all on table public.claw_user_knowledge from public, anon, authenticated;
revoke all on table public.claw_user_skills from public, anon, authenticated;
revoke all on table public.claw_learning_events from public, anon, authenticated;
revoke all on table public.claw_learning_proposals from public, anon, authenticated;
revoke all on table public.commerce_hunts from public, anon, authenticated;

grant select, insert, update, delete on table public.claw_admins to service_role;
grant select, insert, update, delete on table public.claw_releases to service_role;
grant select, insert, update, delete on table public.claw_documents to service_role;
grant select, insert, update, delete on table public.claw_capabilities to service_role;
grant select, insert, update, delete on table public.claw_user_profiles to service_role;
grant select, insert, update, delete on table public.claw_user_knowledge to service_role;
grant select, insert, update, delete on table public.claw_user_skills to service_role;
grant select, insert, update, delete on table public.claw_learning_events to service_role;
grant select, insert, update, delete on table public.claw_learning_proposals to service_role;
grant select, insert, update, delete on table public.commerce_hunts to service_role;

revoke all on function public.claw_guard_release_mutation() from public, anon, authenticated;
revoke all on function public.claw_guard_release_artifact_mutation() from public, anon, authenticated;
revoke all on function public.claw_clone_release(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.claw_create_release(uuid, text, text) from public, anon, authenticated;
revoke all on function public.claw_save_document(uuid, uuid, bigint, text, text, text, text, boolean, jsonb, text) from public, anon, authenticated;
revoke all on function public.claw_save_capability(uuid, uuid, bigint, text, text, boolean, jsonb, text, text[], text) from public, anon, authenticated;
revoke all on function public.claw_review_proposal(uuid, uuid, text, uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.claw_publish_release(uuid, uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.claw_stable_json(jsonb) from public, anon, authenticated;
grant execute on function public.claw_clone_release(uuid, uuid, text, text) to service_role;
grant execute on function public.claw_create_release(uuid, text, text) to service_role;
grant execute on function public.claw_save_document(uuid, uuid, bigint, text, text, text, text, boolean, jsonb, text) to service_role;
grant execute on function public.claw_save_capability(uuid, uuid, bigint, text, text, boolean, jsonb, text, text[], text) to service_role;
grant execute on function public.claw_review_proposal(uuid, uuid, text, uuid, bigint, text) to service_role;
grant execute on function public.claw_publish_release(uuid, uuid, bigint, text) to service_role;
grant execute on function public.claw_stable_json(jsonb) to service_role;
