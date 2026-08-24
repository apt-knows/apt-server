import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import pg from 'pg';
import { hermesApiKey } from '../src/agent-runtime.js';
import { loadConfig } from '../src/config.js';
import type { ChatPage, ChatRun, CreatedTurn, PublicRunEvent } from '../src/domain.js';

const config = loadConfig();
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key?.startsWith('--') && value) args.set(key.slice(2), value);
}
const userA = args.get('user-a');
const userB = args.get('user-b');
const baseUrl = (args.get('base-url') ?? `http://127.0.0.1:${config.port}`).replace(/\/$/, '');
if (!userA || !userB || userA === userB) {
  throw new Error('Usage: npm run test:e2e-live -- --user-a <uuid> --user-b <different-uuid> [--base-url <url>]');
}

const admin = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

async function accessToken(userId: string) {
  const userResult = await admin.auth.admin.getUserById(userId);
  const email = userResult.data.user?.email;
  if (userResult.error || !email) throw new Error(`Could not resolve email auth for ${userId}.`);
  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  const tokenHash = link.data.properties?.hashed_token;
  if (link.error || !tokenHash) throw new Error(`Could not create a test session for ${userId}.`);
  const client = createClient(config.supabase.url, config.supabase.publishableKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const verified = await client.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
  const token = verified.data.session?.access_token;
  if (verified.error || !token || verified.data.user?.id !== userId) {
    throw new Error(`Could not verify the test session for ${userId}.`);
  }
  return token;
}

async function request<T>(token: string | null, path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(180_000),
  });
  const body = await response.json().catch(() => null) as T | { error?: { code?: string; message?: string } } | null;
  return { response, body };
}

async function expectError(token: string | null, path: string, status: number, code: string) {
  const result = await request<{ error?: { code?: string } }>(token, path);
  assert(result.response.status === status, `${path} returned ${result.response.status}; expected ${status}.`);
  assert(result.body?.error?.code === code, `${path} returned the wrong error code.`);
}

async function streamRun(token: string, runId: string) {
  const response = await fetch(`${baseUrl}/v1/chat/runs/${runId}/events`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal: AbortSignal.timeout(180_000),
  });
  assert(response.ok && response.body, `Run stream returned ${response.status}.`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: PublicRunEvent[] = [];
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split(/\r?\n/).find((line) => line.startsWith('data:'))?.slice(5).trim();
      if (data) events.push(JSON.parse(data) as PublicRunEvent);
      boundary = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
  assert(events[0]?.type === 'run.snapshot', 'Run stream did not begin with a snapshot.');
  const terminal = events.at(-1);
  assert(terminal?.type === 'run.completed' || terminal?.type === 'run.cancelled' || terminal?.type === 'run.failed', 'Run stream did not terminate.');
  return events;
}

interface LiveForegroundLocation {
  latitude: number;
  longitude: number;
  accuracy: number;
  capturedAt: string;
  coarseLabel: string;
}

interface HermesIdentity {
  profileName: string;
  sessionId: string;
}

interface HermesSessionMessage {
  id?: unknown;
  role?: unknown;
  content?: unknown;
  tool_calls?: unknown;
  tool_name?: unknown;
  timestamp?: unknown;
}

async function createAndComplete(token: string, content: string, location?: LiveForegroundLocation) {
  const clientMessageId = randomUUID();
  const payload = JSON.stringify({ clientMessageId, content, ...(location ? { location } : {}) });
  const first = await request<CreatedTurn>(token, '/v1/chat/messages', {
    method: 'POST', body: payload,
  });
  assert(first.response.status === 202 && first.body && 'run' in first.body, 'Message was not accepted.');
  const turn = first.body as CreatedTurn;
  const duplicate = await request<CreatedTurn>(token, '/v1/chat/messages', {
    method: 'POST', body: payload,
  });
  assert(duplicate.response.status === 200 && duplicate.body && 'run' in duplicate.body, 'Duplicate was not handled idempotently.');
  assert((duplicate.body as CreatedTurn).run.id === turn.run.id, 'Duplicate created a different run.');
  const events = await streamRun(token, turn.run.id);
  const final = await request<ChatRun>(token, `/v1/chat/runs/${turn.run.id}`);
  assert(final.response.ok && final.body && 'status' in final.body, 'Final run snapshot was unavailable.');
  const run = final.body as ChatRun;
  assert(run.status === 'completed', `Expected completed run; received ${run.status}.`);
  assert(Boolean(run.response?.content.trim()), 'Completed response was empty.');
  return { turn, events, run };
}

async function loadHermesIdentity(userId: string): Promise<HermesIdentity> {
  const client = new pg.Client({
    connectionString: config.supabase.databaseUrl,
    ssl: config.supabase.databaseSsl ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    const result = await client.query<{ hermes_profile_name: string; hermes_session_id: string }>(
      `select hermes_profile_name, hermes_session_id
       from public.agent_instances
       where user_id = $1 and status = 'ready'`,
      [userId],
    );
    assert(result.rowCount === 1, 'Founder does not have exactly one ready Hermes agent instance.');
    return {
      profileName: result.rows[0]!.hermes_profile_name,
      sessionId: result.rows[0]!.hermes_session_id,
    };
  } finally {
    await client.end();
  }
}

function hermesProfileBaseUrl(profileName: string) {
  if (config.hermes.topology === 'shared') {
    return `${config.hermes.baseUrl}/p/${encodeURIComponent(profileName)}`;
  }
  const configured = config.hermes.profileUrls[profileName];
  if (configured) return configured.replace(/\/$/, '');
  return config.hermes.profileUrlTemplate.replace('{profile}', encodeURIComponent(profileName)).replace(/\/$/, '');
}

async function loadHermesMessages(identity: HermesIdentity) {
  const response = await fetch(
    `${hermesProfileBaseUrl(identity.profileName)}/api/sessions/${encodeURIComponent(identity.sessionId)}/messages?limit=500&order=latest`,
    {
      headers: {
        Authorization: `Bearer ${hermesApiKey(identity.profileName, config.hermes.keySecret)}`,
        'X-Hermes-Session-Key': `apt:${identity.profileName}`,
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  assert(response.ok, `Hermes session trace returned ${response.status}.`);
  const body = await response.json() as { data?: unknown };
  assert(Array.isArray(body.data), 'Hermes session trace did not return messages.');
  return body.data as HermesSessionMessage[];
}

function hermesMessageFingerprint(message: HermesSessionMessage) {
  if (typeof message.id === 'string' || typeof message.id === 'number') return `id:${String(message.id)}`;
  return `body:${JSON.stringify(message)}`;
}

function browserToolNames(messages: HermesSessionMessage[]) {
  const names = new Set<string>();
  const collectToolCall = (value: unknown): void => {
    if (typeof value === 'string') {
      try {
        collectToolCall(JSON.parse(value) as unknown);
      } catch {
        // A plain tool result is not a tool-call envelope.
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) collectToolCall(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const call = value as Record<string, unknown>;
    if (typeof call.name === 'string') names.add(call.name);
    if (typeof call.tool_name === 'string') names.add(call.tool_name);
    if (call.function && typeof call.function === 'object') {
      const functionName = (call.function as Record<string, unknown>).name;
      if (typeof functionName === 'string') names.add(functionName);
    }
  };
  for (const message of messages) {
    if (typeof message.tool_name === 'string') names.add(message.tool_name);
    collectToolCall(message.tool_calls);
  }
  return [...names].sort();
}

async function verifyPersistedBrowserHunt(
  userId: string,
  runId: string,
  location: LiveForegroundLocation,
  identity: HermesIdentity,
  priorHermesMessageFingerprints: Set<string>,
) {
  const client = new pg.Client({
    connectionString: config.supabase.databaseUrl,
    ssl: config.supabase.databaseSsl ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  try {
    const result = await client.query<{
      status: string;
      category: string;
      coarse_location_label: string | null;
      query: unknown;
      constraints: unknown;
      candidates: unknown;
      source_urls: unknown;
      claw_mode: string | null;
      request_content: string;
      hermes_profile_name: string;
      hermes_session_id: string;
    }>(
      `select h.status, h.category, h.coarse_location_label, h.query, h.constraints,
              h.candidates, h.source_urls,
              r.claw_mode, m.content as request_content,
              i.hermes_profile_name, i.hermes_session_id
       from public.commerce_hunts h
       join public.agent_runs r on r.id = h.agent_run_id and r.user_id = h.user_id
       join public.messages m on m.id = h.request_message_id and m.user_id = h.user_id
       join public.agent_instances i on i.user_id = h.user_id
       where h.user_id = $1 and h.agent_run_id = $2`,
      [userId, runId],
    );
    assert(result.rowCount === 1, 'Completed run did not persist exactly one owned commerce Hunt.');
    const row = result.rows[0]!;
    assert(row.status === 'completed' && row.claw_mode === 'hunt', 'Browser Hunt did not settle as a completed Hunt run.');
    assert(row.category === 'retail', `Browser Hunt persisted unexpected category ${row.category}.`);
    assert(row.coarse_location_label === location.coarseLabel, 'Browser Hunt did not persist the expected coarse location label.');
    assert(row.hermes_profile_name === identity.profileName && row.hermes_session_id === identity.sessionId, 'Browser Hunt ran under an unexpected Hermes identity.');
    assert(Array.isArray(row.candidates) && row.candidates.length > 0 && row.candidates.length <= 5, 'Browser Hunt persisted an invalid candidate count.');
    assert(Array.isArray(row.source_urls) && row.source_urls.length > 0, 'Browser Hunt persisted no source URLs.');
    const sourceUrls = row.source_urls.filter((value): value is string => typeof value === 'string');
    assert(sourceUrls.length === row.source_urls.length, 'Browser Hunt persisted a non-string source URL.');
    for (const sourceUrl of sourceUrls) {
      const parsed = new URL(sourceUrl);
      assert(parsed.protocol === 'http:' || parsed.protocol === 'https:', 'Browser Hunt persisted a non-public source URL.');
    }
    const persistenceText = JSON.stringify(row);
    assert(!persistenceText.includes(String(location.latitude)), 'Exact latitude was persisted in Hunt data.');
    assert(!persistenceText.includes(String(location.longitude)), 'Exact longitude was persisted in Hunt data.');

    const currentHermesMessages = await loadHermesMessages(identity);
    const huntTrace = currentHermesMessages.filter(
      (message) => !priorHermesMessageFingerprints.has(hermesMessageFingerprint(message)),
    );
    assert(huntTrace.length > 0, 'Hermes session trace contained no messages for the browser Hunt.');
    const toolNames = browserToolNames(huntTrace);
    assert(toolNames.includes('browser_navigate'), 'Hermes Hunt trace did not navigate to a public site.');
    assert(toolNames.includes('browser_snapshot'), 'Hermes Hunt trace did not inspect a browser page.');
    assert(
      ['browser_click', 'browser_type', 'browser_press'].some((toolName) => toolNames.includes(toolName)),
      'Hermes Hunt trace did not interact with a public search or store flow.',
    );
    assert(!toolNames.includes('web_search'), 'Hermes Hunt trace used forbidden API-backed web_search.');
    return {
      candidateCount: row.candidates.length,
      sourceUrls,
      traceMessageCount: huntTrace.length,
      toolNames,
    };
  } finally {
    await client.end();
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const [tokenA, tokenB] = await Promise.all([accessToken(userA), accessToken(userB)]);
await expectError(null, '/v1/chat', 401, 'UNAUTHENTICATED');

const writeContext = args.get('write-context');
const recallContext = args.get('recall-context');
const leaveRunning = args.get('leave-running');
if (leaveRunning) {
  const started = await request<CreatedTurn>(tokenA, '/v1/chat/messages', {
    method: 'POST', body: JSON.stringify({ clientMessageId: randomUUID(), content: leaveRunning }),
  });
  assert(started.response.status === 202 && started.body && 'run' in started.body, 'Restart probe message was not accepted.');
  const runId = (started.body as CreatedTurn).run.id;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const snapshot = await request<ChatRun>(tokenA, `/v1/chat/runs/${runId}`);
    if (snapshot.body && 'status' in snapshot.body && (snapshot.body as ChatRun).status === 'running') {
      process.stdout.write(JSON.stringify({ ok: true, runId, status: 'running' }) + '\n');
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Restart probe did not reach running state.');
}
if (writeContext || recallContext) {
  const content = writeContext
    ? `Remember the exact secret phrase ${writeContext} for my next turn. Reply with the phrase.`
    : 'What exact secret phrase did I ask you to remember in my immediately preceding turn? Reply with only that phrase.';
  const result = await createAndComplete(tokenA, content);
  const expected = writeContext ?? recallContext!;
  assert(result.run.response?.content.includes(expected), 'Hermes session context verification failed.');
  process.stdout.write(JSON.stringify({ ok: true, context: writeContext ? 'written' : 'recalled' }) + '\n');
  process.exit(0);
}

const markerA = `APT-E2E-A-${Date.now()}`;
const markerB = `APT-E2E-B-${Date.now()}`;
const completedA = await createAndComplete(tokenA, `Reply briefly and include this exact marker: ${markerA}`);
await expectError(tokenB, `/v1/chat/runs/${completedA.turn.run.id}`, 404, 'RUN_NOT_FOUND');

const historyA = await request<ChatPage>(tokenA, '/v1/chat?limit=1');
assert(historyA.response.ok && historyA.body && 'messages' in historyA.body, 'User A history was unavailable.');
assert(Boolean((historyA.body as ChatPage).olderCursor), 'Pagination did not return an older cursor.');
const olderA = await request<ChatPage>(tokenA, `/v1/chat?limit=10&before=${(historyA.body as ChatPage).olderCursor}`);
assert(olderA.response.ok && olderA.body && 'messages' in olderA.body, 'Older history was unavailable.');
assert((olderA.body as ChatPage).messages.some((message) => message.content.includes(markerA)), 'User A marker was not persisted.');

await createAndComplete(tokenB, `Reply briefly and include this exact marker: ${markerB}`);
const historyB = await request<ChatPage>(tokenB, '/v1/chat?limit=100');
assert(historyB.response.ok && historyB.body && 'messages' in historyB.body, 'User B history was unavailable.');
assert((historyB.body as ChatPage).messages.some((message) => message.content.includes(markerB)), 'User B marker was not persisted.');
assert(!(historyB.body as ChatPage).messages.some((message) => message.content.includes(markerA)), 'User A content leaked into user B history.');

let huntEvidence: {
  candidateCount: number;
  sourceUrls: string[];
  traceMessageCount: number;
  toolNames: string[];
} | null = null;
if (args.get('verify-hunt') === 'true') {
  const location: LiveForegroundLocation = {
    latitude: 40.74843123,
    longitude: -73.98565678,
    accuracy: 25,
    capturedAt: new Date().toISOString(),
    coarseLabel: 'New York, NY, 10001, US',
  };
  const hermesIdentity = await loadHermesIdentity(userA);
  const priorHermesMessageFingerprints = new Set(
    (await loadHermesMessages(hermesIdentity)).map(hermesMessageFingerprint),
  );
  const hunt = await createAndComplete(
    tokenA,
    'Run a local retail Hunt that requires my current location. Open a public search engine or retailer search page with browser_navigate, type the query into its search field, interact with the results, and inspect the current source pages. Find two currently available running shoes from public retailer or brand stores near me, compare them, and include the source links. Do not use API-backed web_search.',
    location,
  );
  huntEvidence = await verifyPersistedBrowserHunt(
    userA,
    hunt.turn.run.id,
    location,
    hermesIdentity,
    priorHermesMessageFingerprints,
  );
  assert(huntEvidence.sourceUrls.some((url) => hunt.run.response?.content.includes(url)), 'Browser Hunt response did not expose any persisted source URL.');
  assert(!hunt.run.response?.content.includes(String(location.latitude)), 'Browser Hunt response exposed exact latitude.');
  assert(!hunt.run.response?.content.includes(String(location.longitude)), 'Browser Hunt response exposed exact longitude.');
}

const stopTurn = await request<CreatedTurn>(tokenB, '/v1/chat/messages', {
  method: 'POST',
  body: JSON.stringify({ clientMessageId: randomUUID(), content: 'Write a very long numbered list with at least 5000 items.' }),
});
assert(stopTurn.response.status === 202 && stopTurn.body && 'run' in stopTurn.body, 'Stop test message was not accepted.');
const stopRunId = (stopTurn.body as CreatedTurn).run.id;
const stopping = await request<ChatRun>(tokenB, `/v1/chat/runs/${stopRunId}/stop`, { method: 'POST' });
assert(stopping.response.status === 202, 'Stop request was not accepted.');
const stopEvents = await streamRun(tokenB, stopRunId);
const stopTerminal = stopEvents.at(-1);
assert(stopTerminal?.type === 'run.cancelled' || stopTerminal?.type === 'run.completed', 'Stopped run did not settle safely.');

process.stdout.write(JSON.stringify({
  ok: true,
  checks: {
    health: true,
    authentication: true,
    messageAndSse: true,
    idempotency: true,
    pagination: true,
    stop: true,
    crossUserIsolation: true,
    browserHunt: args.get('verify-hunt') === 'true',
  },
  eventCounts: { userA: completedA.events.length, stop: stopEvents.length },
  ...(huntEvidence ? { huntEvidence: {
    candidateCount: huntEvidence.candidateCount,
    sourceCount: huntEvidence.sourceUrls.length,
    traceMessageCount: huntEvidence.traceMessageCount,
    toolNames: huntEvidence.toolNames,
  } } : {}),
}) + '\n');
