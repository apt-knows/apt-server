-- APT-8 correction: Hunts are performed by Hermes browser automation, not a commerce API.
-- Keep the database and founder control plane aligned with the code-approved browser toolset.

create or replace function public.claw_save_capability(
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
  if p_key not in ('memory', 'session_search', 'skills', 'browser', 'apt_bridge') then
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

create or replace function public.claw_review_proposal(
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
      if p_target_key not in ('memory', 'session_search', 'skills', 'browser', 'apt_bridge') then
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

create or replace function public.claw_publish_release(
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
    where claw_capabilities.release_id = p_release_id and enabled and key not in ('memory', 'session_search', 'skills', 'browser', 'apt_bridge')
  ) or exists (
    select 1 from public.claw_capabilities
    where claw_capabilities.release_id = p_release_id and enabled and kind = 'mcp' and key <> 'apt_bridge'
  ) then
    raise exception 'Draft enables a capability outside the code-approved allowlist.' using errcode = '23514';
  end if;

  if not exists (select 1 from public.claw_capabilities c where c.release_id = p_release_id and c.key = 'apt_bridge' and c.kind = 'mcp' and c.enabled)
    or not exists (select 1 from public.claw_capabilities c where c.release_id = p_release_id and c.key = 'memory' and c.kind = 'toolset' and c.enabled)
    or not exists (select 1 from public.claw_capabilities c where c.release_id = p_release_id and c.key = 'session_search' and c.kind = 'toolset' and c.enabled)
    or not exists (select 1 from public.claw_capabilities c where c.release_id = p_release_id and c.key = 'skills' and c.kind = 'toolset' and c.enabled)
    or not exists (select 1 from public.claw_capabilities c where c.release_id = p_release_id and c.key = 'browser' and c.kind = 'toolset' and c.enabled) then
    raise exception 'Draft must enable the Apt bridge and narrow memory/session-search/skills/browser toolsets.' using errcode = '23514';
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
