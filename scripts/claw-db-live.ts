import assert from 'node:assert/strict';
import pg from 'pg';
import { loadConfig } from '../src/config.js';
import {
  capabilityChecksum,
  compileClawTurn,
  documentChecksum,
} from '../src/claw/compiler.js';
import type { ClawCapability, ClawDocument, ClawTurnBundle } from '../src/claw/domain.js';

interface ReleaseRow {
  id: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  base_release_id: string | null;
  revision: string;
  content_checksum: string | null;
}

interface DocumentRow {
  key: string;
  kind: ClawDocument['kind'];
  title: string;
  content: string;
  enabled: boolean;
  metadata: Record<string, unknown>;
  checksum: string;
}

interface CapabilityRow {
  key: ClawCapability['key'];
  kind: ClawCapability['kind'];
  enabled: boolean;
  config: Record<string, unknown>;
  instructions: string;
  secret_refs: string[];
  checksum: string;
}

const config = loadConfig();
const client = new pg.Client({
  connectionString: config.supabase.databaseUrl,
  ssl: config.supabase.databaseSsl ? { rejectUnauthorized: false } : false,
});
const marker = `APT Claw transactional verification ${new Date().toISOString()}`;
let releaseId = '';
let founderId = '';
let founderWasAdmin = false;

await client.connect();
try {
  const founder = await client.query<{ user_id: string }>(
    `select user_id from public.agent_instances where status = 'ready' order by user_id limit 1`,
  );
  founderId = founder.rows[0]?.user_id ?? '';
  assert(founderId, 'A ready beta user is required for the transactional Claw verification.');
  founderWasAdmin = (await client.query(
    `select 1 from public.claw_admins where user_id = $1`,
    [founderId],
  )).rowCount === 1;

  await client.query('begin');
  await client.query(
    `insert into public.claw_admins(user_id, granted_by) values ($1, $1)
     on conflict (user_id) do nothing`,
    [founderId],
  );

  await expectSqlState('unauthorized_release', '42501', () => client.query(
    `select * from public.claw_create_release($1, $2, $3)`,
    ['00000000-0000-4000-8000-000000000000', marker, 'must be denied'],
  ));

  const created = await client.query<ReleaseRow>(
    `select * from public.claw_create_release($1, $2, $3)`,
    [founderId, marker, 'transactional verification only'],
  );
  const release = created.rows[0];
  assert(release, 'Claw release creation returned no row.');
  releaseId = release.id;
  assert.equal(release.status, 'draft');
  assert.equal(Number(release.revision), 1);

  const documents: Array<Omit<ClawDocument, 'checksum'>> = [
    { key: 'core.identity', kind: 'core', title: 'Core identity', content: 'Be a concise Apt commerce agent.', enabled: true, metadata: {} },
    { key: 'soul.default', kind: 'soul_template', title: 'Soul template', content: 'Adapt tone without weakening shared policy.', enabled: true, metadata: {} },
    { key: 'policy.boundary', kind: 'policy', title: 'Safety boundary', content: 'Never purchase, order, or checkout.', enabled: true, metadata: {} },
    { key: 'intent.retail', kind: 'intent', title: 'Retail intent', content: 'Support retail product discovery.', enabled: true, metadata: {} },
    { key: 'intent.grocery', kind: 'intent', title: 'Grocery intent', content: 'Support grocery discovery.', enabled: true, metadata: {} },
    { key: 'intent.food', kind: 'intent', title: 'Food intent', content: 'Support restaurant and food discovery.', enabled: true, metadata: {} },
  ];
  let revision = Number(release.revision);
  for (const document of documents) {
    const checksum = documentChecksum(document);
    const saved = await client.query<ReleaseRow>(
      `select * from public.claw_save_document($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [founderId, release.id, revision, document.key, document.kind, document.title,
        document.content, document.enabled, document.metadata, checksum],
    );
    revision = Number(saved.rows[0]?.revision);
  }

  const capabilities: Array<Omit<ClawCapability, 'checksum'>> = [
    { key: 'memory', kind: 'toolset', enabled: true, config: {}, instructions: '', secretRefs: [] },
    { key: 'session_search', kind: 'toolset', enabled: true, config: {}, instructions: '', secretRefs: [] },
    { key: 'skills', kind: 'toolset', enabled: true, config: {}, instructions: '', secretRefs: [] },
    { key: 'apt_bridge', kind: 'mcp', enabled: true, config: {}, instructions: '', secretRefs: ['APT_BRIDGE_TOKEN'] },
  ];
  for (const capability of capabilities) {
    const checksum = capabilityChecksum(capability);
    const saved = await client.query<ReleaseRow>(
      `select * from public.claw_save_capability($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [founderId, release.id, revision, capability.key, capability.kind, capability.enabled,
        capability.config, capability.instructions, capability.secretRefs, checksum],
    );
    revision = Number(saved.rows[0]?.revision);
  }
  assert.equal(revision, 11);

  await expectSqlState('stale_revision', '40001', () => client.query(
    `select * from public.claw_save_document($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [founderId, release.id, revision - 1, 'core.identity', 'core', 'Core identity',
      'stale write', true, {}, documentChecksum({ content: 'stale write' })],
  ));
  await expectSqlState('empty_publish_note', '22023', () => client.query(
    `select * from public.claw_publish_release($1, $2, $3, $4)`,
    [release.id, founderId, revision, ''],
  ));

  const published = (await client.query<ReleaseRow>(
    `select * from public.claw_publish_release($1, $2, $3, $4)`,
    [release.id, founderId, revision, 'Transactional release verification'],
  )).rows[0];
  assert(published?.content_checksum, 'Published release did not receive a manifest checksum.');
  assert.equal(published.status, 'published');

  const storedDocuments = (await client.query<DocumentRow>(
    `select key, kind, title, content, enabled, metadata, checksum
     from public.claw_documents where release_id = $1 order by key`,
    [release.id],
  )).rows;
  const storedCapabilities = (await client.query<CapabilityRow>(
    `select key, kind, enabled, config, instructions, secret_refs, checksum
     from public.claw_capabilities where release_id = $1 order by key`,
    [release.id],
  )).rows;
  const bundle: ClawTurnBundle = {
    release: {
      id: published.id,
      version: published.version,
      checksum: published.content_checksum,
      documents: storedDocuments,
      capabilities: storedCapabilities.map(({ secret_refs, ...capability }) => ({
        ...capability,
        secretRefs: secret_refs,
      })),
    },
    profile: { soulText: '', hotUserText: '', hotMemoryText: '', revision: '1', knowledgeRevision: '0', runtimeHash: null },
    knowledge: [],
    privateSkills: [],
    previousHunts: [],
    conversationHistory: [],
  };
  const compiled = compileClawTurn(bundle);
  assert.match(compiled.runtimeHash, /^[a-f0-9]{64}$/);

  await expectSqlState('published_mutation', '55000', () => client.query(
    `update public.claw_releases set name = 'tampered' where id = $1`,
    [release.id],
  ));

  const cloned = (await client.query<ReleaseRow>(
    `select * from public.claw_clone_release($1, $2, $3, $4)`,
    [release.id, founderId, `${marker} rollback`, 'transactional rollback verification'],
  )).rows[0];
  assert(cloned, 'Claw release cloning returned no row.');
  assert.equal(cloned.base_release_id, release.id);
  assert.equal(cloned.status, 'draft');
  const republished = (await client.query<ReleaseRow>(
    `select * from public.claw_publish_release($1, $2, $3, $4)`,
    [cloned.id, founderId, Number(cloned.revision), 'Transactional rollback publish'],
  )).rows[0];
  assert.equal(republished?.status, 'published');
  const releaseStatuses = (await client.query<{ id: string; status: string }>(
    `select id, status from public.claw_releases where id = any($1::uuid[]) order by version`,
    [[release.id, cloned.id]],
  )).rows;
  assert.deepEqual(releaseStatuses.map((row) => row.status), ['archived', 'published']);

  await client.query('rollback');

  assert.equal((await client.query(
    `select 1 from public.claw_releases where id = $1`,
    [release.id],
  )).rowCount, 0, 'Transactional release persisted after rollback.');
  assert.equal((await client.query(
    `select 1 from public.claw_admins where user_id = $1`,
    [founderId],
  )).rowCount === 1, founderWasAdmin, 'Transactional founder grant persisted after rollback.');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    checks: {
      founderAuthorization: true,
      optimisticRevision: true,
      requiredPublishNote: true,
      validationAndPublish: true,
      compilerChecksumParity: true,
      publishedImmutability: true,
      cloneAndAtomicArchive: true,
      fullRollback: true,
    },
  }, null, 2)}\n`);
} catch (error) {
  try { await client.query('rollback'); } catch { /* connection may already be closed */ }
  throw error;
} finally {
  await client.end();
}

async function expectSqlState(label: string, expectedCode: string, operation: () => Promise<unknown>) {
  await client.query(`savepoint ${label}`);
  let receivedCode: string | undefined;
  try {
    await operation();
  } catch (error) {
    receivedCode = (error as { code?: string }).code;
  }
  await client.query(`rollback to savepoint ${label}`);
  await client.query(`release savepoint ${label}`);
  assert.equal(receivedCode, expectedCode, `${label} returned SQLSTATE ${receivedCode ?? 'none'}.`);
}
