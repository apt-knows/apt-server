import { Pool, type QueryResultRow } from 'pg';
import { AppError } from '../errors.js';
import type {
  ClawCapability,
  ClawDocument,
  ClawKnowledgeFact,
  ClawPrivateProfile,
  ClawPrivateSkill,
  ClawPublishedRelease,
  ClawTurnBundle,
  ConversationMessage,
  PreviousHunt,
  ProductCandidate,
} from './domain.js';

interface ReleaseRow extends QueryResultRow {
  id: string;
  version: number;
  content_checksum: string;
}

interface DocumentRow extends QueryResultRow {
  key: string;
  kind: ClawDocument['kind'];
  title: string;
  content: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
  checksum: string;
}

interface CapabilityRow extends QueryResultRow {
  key: string;
  kind: ClawCapability['kind'];
  enabled: boolean;
  config: Record<string, unknown>;
  instructions: string;
  secret_refs: string[];
  checksum: string;
}

interface ProfileRow extends QueryResultRow {
  soul_text: string;
  hot_user_text: string;
  hot_memory_text: string;
  revision: string;
  knowledge_revision: string;
  runtime_hash: string | null;
}

interface KnowledgeRow extends QueryResultRow {
  id: string;
  subject_kind: ClawKnowledgeFact['subjectKind'];
  subject_label: string | null;
  category: string;
  fact: string;
  confidence: string;
  learned_at: Date;
}

interface SkillRow extends QueryResultRow {
  key: string;
  title: string;
  content: string;
  checksum: string;
}

interface MessageRow extends QueryResultRow {
  role: ConversationMessage['role'];
  content: string;
}

interface HuntRow extends QueryResultRow {
  id: string;
  category: PreviousHunt['category'];
  candidates: ProductCandidate[];
  created_at: Date;
  status: string;
}

export interface KnowledgeInput {
  subjectKind: ClawKnowledgeFact['subjectKind'];
  subjectLabel: string | null;
  category: string;
  fact: string;
  confidence: number;
  sensitivity: 'low' | 'sensitive';
}

export interface ProposalInput {
  kind: 'core' | 'soul_template' | 'skill' | 'policy' | 'merchant' | 'intent' | 'tool' | 'mcp';
  title: string;
  rationale: string;
  content: string;
}

export interface HuntPersistenceInput {
  userId: string;
  runId: string;
  requestMessageId: string;
  category: PreviousHunt['category'];
  query: Record<string, unknown>;
  constraints: Record<string, unknown>;
  candidates: ProductCandidate[];
  sourceUrls: string[];
  status: 'completed' | 'failed' | 'cancelled';
}

export interface RuntimePrivateArtifacts {
  soulText: string;
  hotUserText: string;
  hotMemoryText: string;
  skills: Array<{ key: string; title: string; content: string; checksum: string }>;
}

export interface ClawRepository {
  loadTurn(userId: string, query: string, historyBudget: number): Promise<ClawTurnBundle>;
  pinRun(userId: string, runId: string, release: ClawPublishedRelease, profile: ClawPrivateProfile, mode?: 'reply' | 'hunt'): Promise<void>;
  setRuntimeHash(userId: string, runtimeHash: string): Promise<void>;
  searchKnowledge(userId: string, query: string, limit: number): Promise<ClawKnowledgeFact[]>;
  remember(userId: string, runId: string, messageId: string, input: KnowledgeInput): Promise<ClawKnowledgeFact>;
  updatePrivateArtifact(userId: string, runId: string, kind: 'soul' | 'user_profile' | 'memory', content: string, expectedRevision: string): Promise<ClawPrivateProfile>;
  createProposal(userId: string, runId: string, input: ProposalInput): Promise<{ id: string; status: 'pending' }>;
  previousHunts(userId: string, query: string, limit: number): Promise<PreviousHunt[]>;
  saveHunt(input: HuntPersistenceInput): Promise<void>;
  reconcileRuntimeArtifacts(userId: string, artifacts: RuntimePrivateArtifacts): Promise<void>;
  close(): Promise<void>;
}

export class PostgresClawRepository implements ClawRepository {
  constructor(private readonly pool: Pool) {}

  static create(databaseUrl: string, ssl: boolean) {
    return new PostgresClawRepository(new Pool({
      connectionString: databaseUrl,
      max: 5,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
    }));
  }

  async close() {
    await this.pool.end();
  }

  async loadTurn(userId: string, query: string, historyBudget: number): Promise<ClawTurnBundle> {
    const releaseResult = await this.pool.query<ReleaseRow>(
      `select id, version, content_checksum from public.claw_releases where status = 'published' limit 1`,
    );
    const releaseRow = releaseResult.rows[0];
    if (!releaseRow?.content_checksum) throw new AppError('UPSTREAM_FAILED', 'No valid published Claw release is available.');
    await this.pool.query(
      `insert into public.claw_user_profiles(user_id) values ($1) on conflict (user_id) do nothing`,
      [userId],
    );
    const [documents, capabilities, profile, knowledge, skills, hunts, messages] = await Promise.all([
      this.pool.query<DocumentRow>(
        `select key, kind, title, content, enabled, metadata, checksum
         from public.claw_documents where release_id = $1 order by key`, [releaseRow.id]),
      this.pool.query<CapabilityRow>(
        `select key, kind, enabled, config, instructions, secret_refs, checksum
         from public.claw_capabilities where release_id = $1 order by key`, [releaseRow.id]),
      this.pool.query<ProfileRow>(
        `select soul_text, hot_user_text, hot_memory_text, revision, knowledge_revision, runtime_hash
         from public.claw_user_profiles where user_id = $1`, [userId]),
      this.searchKnowledge(userId, query, 24),
      this.pool.query<SkillRow>(
        `select key, title, content, checksum from public.claw_user_skills
         where user_id = $1 and status = 'active' order by key`, [userId]),
      this.previousHunts(userId, query, 5),
      this.pool.query<MessageRow>(
        `select role, content from public.messages
         where user_id = $1 and status = 'completed' order by sequence desc limit 500`, [userId]),
    ]);
    const profileRow = profile.rows[0];
    if (!profileRow) throw new Error('Failed to initialize private Claw profile.');
    const publishedRelease: ClawPublishedRelease = {
      id: releaseRow.id,
      version: releaseRow.version,
      checksum: releaseRow.content_checksum,
      documents: documents.rows.map(documentFromRow),
      capabilities: capabilities.rows.map((row) => ({
        key: row.key, kind: row.kind, enabled: row.enabled, config: row.config,
        instructions: row.instructions, secretRefs: row.secret_refs, checksum: row.checksum,
      })),
    };
    return {
      release: publishedRelease,
      profile: profileFromRow(profileRow),
      knowledge,
      privateSkills: skills.rows.map(skillFromRow),
      previousHunts: hunts,
      conversationHistory: boundRecentMessages(messages.rows, historyBudget),
    };
  }

  async pinRun(userId: string, runId: string, release: ClawPublishedRelease, profile: ClawPrivateProfile, mode?: 'reply' | 'hunt') {
    await this.pool.query(
      `update public.agent_runs
       set claw_release_id = $3, claw_release_checksum = $4, claw_profile_revision = $5,
           claw_knowledge_revision = $6, claw_mode = coalesce($7, claw_mode)
       where id = $1 and user_id = $2`,
      [runId, userId, release.id, release.checksum, profile.revision, profile.knowledgeRevision, mode ?? null],
    );
  }

  async setRuntimeHash(userId: string, runtimeHash: string) {
    await this.pool.query(
      `update public.claw_user_profiles set runtime_hash = $2, last_reconciled_at = now(), reconciliation_error = null
       where user_id = $1`, [userId, runtimeHash],
    );
  }

  async searchKnowledge(userId: string, query: string, limit: number) {
    const result = await this.pool.query<KnowledgeRow>(
      `select id, subject_kind, subject_label, category, fact, confidence, learned_at
       from public.claw_user_knowledge
       where user_id = $1 and status = 'active' and (expires_at is null or expires_at > now())
         and confidence >= 0.250
         and ($2 = '' or search_document @@ websearch_to_tsquery('english', $2))
       order by case when $2 = '' then 0 else ts_rank_cd(search_document, websearch_to_tsquery('english', $2)) end desc,
                last_confirmed_at desc nulls last, learned_at desc
       limit $3`,
      [userId, query.trim().slice(0, 1_000), Math.min(Math.max(limit, 1), 50)],
    );
    return result.rows.map(knowledgeFromRow);
  }

  async remember(userId: string, runId: string, messageId: string, input: KnowledgeInput) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const inserted = await client.query<KnowledgeRow>(
        `insert into public.claw_user_knowledge
          (user_id, subject_kind, subject_label, category, fact, confidence, sensitivity, source_message_id, source_agent_run_id)
         select $1, $4, $5, $6, $7, $8, $9, $3, $2
         where not exists (
           select 1 from public.claw_user_knowledge
           where user_id = $1 and source_agent_run_id = $2 and category = $6 and fact = $7 and status = 'active'
         )
         returning id, subject_kind, subject_label, category, fact, confidence, learned_at`,
        [userId, runId, messageId, input.subjectKind, input.subjectLabel, input.category, input.fact, input.confidence, input.sensitivity],
      );
      let row = inserted.rows[0];
      if (!row) {
        const existing = await client.query<KnowledgeRow>(
          `select id, subject_kind, subject_label, category, fact, confidence, learned_at
           from public.claw_user_knowledge
           where user_id = $1 and source_agent_run_id = $2 and category = $3 and fact = $4 and status = 'active' limit 1`,
          [userId, runId, input.category, input.fact],
        );
        row = existing.rows[0];
      } else {
        await client.query(
          `update public.claw_user_profiles set knowledge_revision = knowledge_revision + 1, last_learning_at = now()
           where user_id = $1`, [userId],
        );
        await client.query(
          `insert into public.claw_learning_events
            (user_id, agent_run_id, source_message_id, artifact_kind, action, artifact_id, after_value)
           values ($1, $2, $3, 'knowledge', 'add', $4, jsonb_build_object('category', $5, 'subject_kind', $6))`,
          [userId, runId, messageId, row.id, input.category, input.subjectKind],
        );
      }
      await client.query('commit');
      if (!row) throw new Error('Failed to persist private knowledge.');
      return knowledgeFromRow(row);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async updatePrivateArtifact(
    userId: string,
    runId: string,
    kind: 'soul' | 'user_profile' | 'memory',
    content: string,
    expectedRevision: string,
  ) {
    const column = kind === 'soul' ? 'soul_text' : kind === 'user_profile' ? 'hot_user_text' : 'hot_memory_text';
    const result = await this.pool.query<ProfileRow>(
      `update public.claw_user_profiles
       set ${column} = $3, revision = revision + 1, last_learning_at = now()
       where user_id = $1 and revision = $2
       returning soul_text, hot_user_text, hot_memory_text, revision, knowledge_revision, runtime_hash`,
      [userId, expectedRevision, content],
    );
    const row = result.rows[0];
    if (!row) throw new AppError('RUN_IN_PROGRESS', 'Private artifact revision conflict; retry with the latest profile revision.');
    await this.pool.query(
      `insert into public.claw_learning_events(user_id, agent_run_id, artifact_kind, action, after_value)
       values ($1, $2, $3, 'replace', jsonb_build_object('revision', $4::bigint, 'character_count', $5))`,
      [userId, runId, kind, row.revision, content.length],
    );
    return profileFromRow(row);
  }

  async createProposal(userId: string, runId: string, input: ProposalInput) {
    const result = await this.pool.query<{ id: string } & QueryResultRow>(
      `insert into public.claw_learning_proposals(user_id, agent_run_id, kind, title, rationale, content)
       select $1, $2, $3, $4, $5, $6
       where not exists (
         select 1 from public.claw_learning_proposals
         where user_id = $1 and agent_run_id = $2 and kind = $3 and title = $4 and status = 'pending'
       ) returning id`,
      [userId, runId, input.kind, input.title, input.rationale, input.content],
    );
    const existing = result.rows[0] ?? (await this.pool.query<{ id: string } & QueryResultRow>(
      `select id from public.claw_learning_proposals
       where user_id = $1 and agent_run_id = $2 and kind = $3 and title = $4 and status = 'pending' limit 1`,
      [userId, runId, input.kind, input.title],
    )).rows[0];
    if (!existing) throw new Error('Failed to create shared-change proposal.');
    return { id: existing.id, status: 'pending' as const };
  }

  async previousHunts(userId: string, query: string, limit: number) {
    const result = await this.pool.query<HuntRow>(
      `select id, category, candidates, created_at, status from public.commerce_hunts
       where user_id = $1 and status = 'completed'
         and ($2 = '' or search_document @@ websearch_to_tsquery('english', $2))
       order by case when $2 = '' then 0 else ts_rank_cd(search_document, websearch_to_tsquery('english', $2)) end desc,
                created_at desc limit $3`,
      [userId, query.trim().slice(0, 1_000), Math.min(Math.max(limit, 1), 20)],
    );
    return result.rows.map((row) => ({
      id: row.id,
      category: row.category,
      candidates: row.candidates,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async saveHunt(input: HuntPersistenceInput) {
    await this.pool.query(
      `insert into public.commerce_hunts
        (user_id, agent_run_id, request_message_id, category, status, query, constraints,
         candidates, source_urls, completed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       on conflict (agent_run_id) do nothing`,
      [input.userId, input.runId, input.requestMessageId, input.category, input.status,
        input.query, input.constraints, JSON.stringify(input.candidates), JSON.stringify(input.sourceUrls)],
    );
    await this.pool.query(
      `update public.agent_runs set claw_mode = 'hunt' where id = $1 and user_id = $2`,
      [input.runId, input.userId],
    );
  }

  async reconcileRuntimeArtifacts(userId: string, artifacts: RuntimePrivateArtifacts) {
    if (artifacts.soulText.length > 20_000 || artifacts.hotUserText.length > 1_375 || artifacts.hotMemoryText.length > 2_200) {
      await this.pool.query(
        `update public.claw_user_profiles set reconciliation_error = 'Runtime private artifact exceeded a size limit.' where user_id = $1`,
        [userId],
      );
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const profile = await client.query<ProfileRow>(
        `select soul_text, hot_user_text, hot_memory_text, revision, knowledge_revision, runtime_hash
         from public.claw_user_profiles where user_id = $1 for update`, [userId],
      );
      const current = profile.rows[0];
      if (!current) {
        await client.query('rollback');
        return;
      }
      const profileChanged = current.soul_text !== artifacts.soulText ||
        current.hot_user_text !== artifacts.hotUserText || current.hot_memory_text !== artifacts.hotMemoryText;
      if (profileChanged) {
        await client.query(
          `update public.claw_user_profiles
           set soul_text = $2, hot_user_text = $3, hot_memory_text = $4, revision = revision + 1,
               last_learning_at = now(), last_reconciled_at = now(), reconciliation_error = null
           where user_id = $1`,
          [userId, artifacts.soulText, artifacts.hotUserText, artifacts.hotMemoryText],
        );
        await client.query(
          `insert into public.claw_learning_events(user_id, artifact_kind, action, after_value)
           values ($1, 'user_profile', 'reconcile', jsonb_build_object('source', 'isolated_runtime'))`, [userId],
        );
      } else {
        await client.query(
          `update public.claw_user_profiles set last_reconciled_at = now(), reconciliation_error = null where user_id = $1`,
          [userId],
        );
      }
      for (const skill of artifacts.skills) {
        if (!/^private\.[a-z0-9][a-z0-9_.-]{0,116}$/.test(skill.key) || skill.content.length > 40_000) continue;
        const changed = await client.query<{ id: string } & QueryResultRow>(
          `insert into public.claw_user_skills(user_id, key, title, content, checksum)
           values ($1, $2, $3, $4, $5)
           on conflict (user_id, key) do update
             set title = excluded.title, content = excluded.content, checksum = excluded.checksum,
                 revision = claw_user_skills.revision + 1, status = 'active'
           where claw_user_skills.checksum <> excluded.checksum
           returning id`,
          [userId, skill.key, skill.title, skill.content, skill.checksum],
        );
        if (changed.rows[0]) {
          await client.query(
            `insert into public.claw_learning_events(user_id, artifact_kind, action, artifact_id, after_value)
             values ($1, 'private_skill', 'reconcile', $2, jsonb_build_object('key', $3))`,
            [userId, changed.rows[0].id, skill.key],
          );
        }
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

function documentFromRow(row: DocumentRow): ClawDocument {
  return { key: row.key, kind: row.kind, title: row.title, content: row.content, enabled: row.enabled, metadata: row.metadata, checksum: row.checksum };
}

function profileFromRow(row: ProfileRow): ClawPrivateProfile {
  return {
    soulText: row.soul_text,
    hotUserText: row.hot_user_text,
    hotMemoryText: row.hot_memory_text,
    revision: String(row.revision),
    knowledgeRevision: String(row.knowledge_revision),
    runtimeHash: row.runtime_hash,
  };
}

function knowledgeFromRow(row: KnowledgeRow): ClawKnowledgeFact {
  return {
    id: row.id,
    subjectKind: row.subject_kind,
    subjectLabel: row.subject_label,
    category: row.category,
    fact: row.fact,
    confidence: Number(row.confidence),
    learnedAt: row.learned_at.toISOString(),
  };
}

function skillFromRow(row: SkillRow): ClawPrivateSkill {
  return { key: row.key, title: row.title, content: row.content, checksum: row.checksum };
}

export function boundRecentMessages(rowsNewestFirst: ConversationMessage[], budget: number) {
  const selected: ConversationMessage[] = [];
  let used = 0;
  for (const row of rowsNewestFirst) {
    const cost = row.content.length;
    if (selected.length && used + cost > budget) break;
    if (!selected.length && cost > budget) continue;
    selected.push({ role: row.role, content: row.content });
    used += cost;
  }
  return selected.reverse();
}
