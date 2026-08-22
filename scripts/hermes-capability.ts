import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const hermes = process.env.HERMES_CLI ?? 'hermes';
const version = process.env.HERMES_VERSION ?? 'v2026.8.19';
let gatewayPort = 0;
let providerPort = 0;
const profiles = ['apt-capability-a', 'apt-capability-b'] as const;
const profileKeys = {
  'apt-capability-a': 'api-a-0123456789abcdef0123456789abcdef0123456789abcdef',
  'apt-capability-b': 'api-b-fedcba9876543210fedcba9876543210fedcba9876543210',
};
const providerKeys = { 'apt-capability-a': 'provider-a', 'apt-capability-b': 'provider-b' };
const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const providerRequests: Record<string, string[]> = { 'provider-a': [], 'provider-b': [] };
const activeUrls: Record<typeof profiles[number], string> = {
  'apt-capability-a': '', 'apt-capability-b': '',
};

function configYaml(multiplex: boolean, apiEnabled: boolean, port: number) {
  return `model:\n  default: mock-model\n  provider: custom\n  base_url: http://127.0.0.1:${providerPort}/v1\n  api_key: \${MOCK_PROVIDER_KEY}\nplatform_toolsets:\n  api_server: [no_mcp]\nagent:\n  disabled_toolsets: [web, browser, terminal, file, code_execution, vision, video, image_gen, video_gen, bfl, x_search, tts, stt, skills, todo, memory, context_engine, session_search, clarify, delegation, cronjob, homeassistant, spotify, discord, discord_admin, yuanbao, computer_use]\ngateway:\n  multiplex_profiles: ${multiplex}\n  multiplex_profile_allowlist: [${profiles.join(', ')}]\nplatforms:\n  api_server:\n    enabled: ${apiEnabled}\n    host: 127.0.0.1\n    port: ${port}\n    max_concurrent_runs: 10\n`;
}

async function writeProfile(home: string, profile: typeof profiles[number]) {
  const directory = join(home, 'profiles', profile);
  await writeFile(join(directory, 'config.yaml'), configYaml(false, false, gatewayPort), 'utf8');
  await writeFile(join(directory, '.env'), `API_SERVER_KEY=${profileKeys[profile]}\nMOCK_PROVIDER_KEY=${providerKeys[profile]}\n`, { mode: 0o600 });
}

function providerServer() {
  return createServer(async (request, response) => {
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-model', object: 'model', created: 0, owned_by: 'apt' }] }));
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.statusCode = 404; response.end(); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as { stream?: boolean; messages?: Array<{ role?: string; content?: string }> };
    const providerKey = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const contents = (body.messages ?? []).filter((item) => item.role === 'user').map((item) => item.content ?? '');
    if (providerRequests[providerKey]) providerRequests[providerKey].push(contents.join('\n'));
    const latest = [...(body.messages ?? [])].reverse().find((item) => item.role === 'user')?.content ?? '';
    if (latest.includes('SLOW')) await new Promise((resolve) => setTimeout(resolve, 3_000));
    const output = `mock:${latest}`;
    if (body.stream) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: output }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ id: 'chatcmpl-mock', object: 'chat.completion', created: 0, model: 'mock-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: output } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  });
}

async function api(profile: typeof profiles[number], path: string, init: RequestInit = {}, key = profileKeys[profile]) {
  return fetch(`${activeUrls[profile]}${path}`, { ...init, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
}

async function waitForHealthy(child: ChildProcess, baseUrl: string, diagnostics: () => string) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Hermes gateway exited with ${child.exitCode}:\n${diagnostics()}`);
    try { const response = await fetch(`${baseUrl}/health`); if (response.ok) return; } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Hermes gateway did not become healthy:\n${diagnostics()}`);
}

async function submit(profile: typeof profiles[number], input: string, session = sessionId) {
  const response = await api(profile, '/v1/runs', { method: 'POST', body: JSON.stringify({ input, session_id: session }) });
  if (response.status !== 202) throw new Error(`Run submission failed for ${profile}: ${response.status} ${await response.text()}`);
  const body = await response.json() as { run_id: string };
  return body.run_id;
}

async function waitForRun(profile: typeof profiles[number], runId: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await api(profile, `/v1/runs/${runId}`);
    const body = await response.json() as { status: string; output?: string };
    if (['completed', 'failed', 'cancelled'].includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Run ${runId} did not settle.`);
}

async function startGateway(home: string, port: number, profile?: typeof profiles[number]) {
  const child = spawn(hermes, [...(profile ? ['--profile', profile] : []), 'gateway', 'run', '--force', '--accept-hooks'], {
    env: { ...process.env, HERMES_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  child.once('exit', (code) => { if (code && code !== 143) process.stderr.write(stderr); });
  await waitForHealthy(child, `http://127.0.0.1:${port}`, () => stderr);
  return child;
}

async function stopGateway(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise<void>((resolve) => child.once('exit', () => resolve())), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }

async function reservePort() {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const address = reservation.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a gateway TCP port.');
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  return address.port;
}

const home = await mkdtemp(join(tmpdir(), 'apt-hermes-capability-'));
const provider = providerServer();
let gateways: ChildProcess[] = [];
try {
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerAddress = provider.address();
  if (!providerAddress || typeof providerAddress === 'string') throw new Error('Mock provider did not bind a TCP port.');
  providerPort = providerAddress.port;
  gatewayPort = await reservePort();
  for (const profile of profiles) {
    await execFileAsync(hermes, ['profile', 'create', profile, '--no-alias'], { env: { ...process.env, HERMES_HOME: home }, timeout: 60_000 });
    await writeProfile(home, profile);
  }
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'config.yaml'), configYaml(true, true, gatewayPort), 'utf8');
  await writeFile(join(home, '.env'), 'API_SERVER_KEY=default-0123456789abcdef0123456789abcdef0123456789abcdef\nMOCK_PROVIDER_KEY=provider-default\n', { mode: 0o600 });

  gateways = [await startGateway(home, gatewayPort)];
  for (const profile of profiles) activeUrls[profile] = `http://127.0.0.1:${gatewayPort}/p/${profile}`;
  for (const profile of profiles) {
    const [capabilities, skills, toolsets] = await Promise.all([api(profile, '/v1/capabilities'), api(profile, '/v1/skills'), api(profile, '/v1/toolsets')]);
    assert(capabilities.ok && skills.ok && toolsets.ok, `${profile} discovery endpoints failed.`);
    const skillBody = await skills.json() as unknown[] | { skills?: unknown[]; data?: unknown[] };
    const toolBody = await toolsets.json() as Array<{ enabled?: boolean; tools?: string[] }> | { toolsets?: Array<{ enabled?: boolean; tools?: string[] }>; data?: Array<{ enabled?: boolean; tools?: string[] }> };
    const skillRows = Array.isArray(skillBody) ? skillBody : skillBody.skills ?? skillBody.data ?? [];
    const toolRows = Array.isArray(toolBody) ? toolBody : toolBody.toolsets ?? toolBody.data ?? [];
    assert(skillRows.length > 0, `${profile} did not retain bundled skills: ${JSON.stringify(skillBody).slice(0, 1_000)}`);
    assert(toolRows.every((row) => !row.enabled || !(row.tools?.length)), `${profile} exposed an enabled tool.`);
  }
  assert((await api(profiles[1], '/v1/capabilities', {}, profileKeys[profiles[0]])).status === 401, 'Cross-profile API key was accepted.');
  assert((await api(profiles[0], '/v1/capabilities', {}, 'wrong-key-0123456789abcdef0123456789abcdef')).status === 401, 'Invalid API key was accepted.');

  await waitForRun(profiles[0], await submit(profiles[0], 'alpha-private'));
  await waitForRun(profiles[1], await submit(profiles[1], 'beta-private'));
  const concurrent = await Promise.all([
    submit(profiles[0], 'alpha-concurrent', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
    submit(profiles[1], 'beta-concurrent', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ]);
  await Promise.all([waitForRun(profiles[0], concurrent[0]), waitForRun(profiles[1], concurrent[1])]);
  const sharedProviderIsolation = providerRequests['provider-a']!.every((request) => !request.includes('beta-private') && !request.includes('beta-concurrent'))
    && providerRequests['provider-b']!.every((request) => !request.includes('alpha-private') && !request.includes('alpha-concurrent'))
    && providerRequests['provider-a']!.length > 0 && providerRequests['provider-b']!.length > 0;

  const sessionsA = await (await api(profiles[0], '/api/sessions')).text();
  const sessionsB = await (await api(profiles[1], '/api/sessions')).text();
  assert(!sessionsA.includes('beta-private') && !sessionsB.includes('alpha-private'), 'Session APIs leaked cross-profile content.');
  const stateA = await readdir(join(home, 'profiles', profiles[0]));
  const stateB = await readdir(join(home, 'profiles', profiles[1]));
  assert(stateA.includes('state.db') && stateB.includes('state.db'), 'Profiles did not create independent state databases.');

  await Promise.all(gateways.map(stopGateway)); gateways = [];

  // v0.20.5 still resolves both named profiles' custom-provider credential from
  // the first profile in a shared process. Exercise the required process-isolated fallback.
  const isolatedPorts = await Promise.all(profiles.map(() => reservePort()));
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index]!;
    const port = isolatedPorts[index]!;
    await writeFile(join(home, 'profiles', profile, 'config.yaml'), configYaml(false, true, port), 'utf8');
    activeUrls[profile] = `http://127.0.0.1:${port}`;
  }
  gateways = await Promise.all(profiles.map((profile, index) => startGateway(home, isolatedPorts[index]!, profile)));
  providerRequests['provider-a'] = [];
  providerRequests['provider-b'] = [];

  assert((await api(profiles[1], '/v1/capabilities', {}, profileKeys[profiles[0]])).status === 401, 'Fallback accepted a cross-profile API key.');
  await waitForRun(profiles[0], await submit(profiles[0], 'fallback-alpha-private', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
  await waitForRun(profiles[1], await submit(profiles[1], 'fallback-beta-private', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
  const fallbackConcurrent = await Promise.all([
    submit(profiles[0], 'fallback-alpha-concurrent', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
    submit(profiles[1], 'fallback-beta-concurrent', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  ]);
  await Promise.all([waitForRun(profiles[0], fallbackConcurrent[0]), waitForRun(profiles[1], fallbackConcurrent[1])]);
  assert(providerRequests['provider-a']!.every((request) => !request.includes('fallback-beta')), `Fallback profile A contains profile B context: ${JSON.stringify(providerRequests)}`);
  assert(providerRequests['provider-b']!.every((request) => !request.includes('fallback-alpha')), `Fallback profile B contains profile A context: ${JSON.stringify(providerRequests)}`);
  assert(providerRequests['provider-a']!.length > 0 && providerRequests['provider-b']!.length > 0, 'Fallback did not use distinct provider credentials.');

  const fallbackSessionsA = await (await api(profiles[0], '/api/sessions')).text();
  const fallbackSessionsB = await (await api(profiles[1], '/api/sessions')).text();
  assert(!fallbackSessionsA.includes('fallback-beta') && !fallbackSessionsB.includes('fallback-alpha'), 'Fallback session history leaked across profiles.');

  const slowRun = await submit(profiles[0], 'SLOW fallback stop', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const stopResponse = await api(profiles[0], `/v1/runs/${slowRun}/stop`, { method: 'POST' });
  assert(stopResponse.ok, `Fallback stop returned ${stopResponse.status}.`);
  const stopped = await waitForRun(profiles[0], slowRun);
  assert(stopped.status === 'cancelled', `Stopped run settled as ${stopped.status}.`);

  await Promise.all(gateways.map(stopGateway)); gateways = [];
  const restartPorts = await Promise.all(profiles.map(() => reservePort()));
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = profiles[index]!;
    await writeFile(join(home, 'profiles', profile, 'config.yaml'), configYaml(false, true, restartPorts[index]!), 'utf8');
    activeUrls[profile] = `http://127.0.0.1:${restartPorts[index]!}`;
  }
  gateways = await Promise.all(profiles.map((profile, index) => startGateway(home, restartPorts[index]!, profile)));
  const restartedA = await (await api(profiles[0], '/api/sessions')).text();
  const restartedB = await (await api(profiles[1], '/api/sessions')).text();
  assert(!restartedA.includes('fallback-beta') && !restartedB.includes('fallback-alpha'), 'Fallback restart introduced cross-profile session leakage.');

  const report = {
    hermesVersion: version,
    sharedTopology: { result: sharedProviderIsolation ? 'pass' : 'fail', reason: sharedProviderIsolation ? null : 'custom provider credential resolved from profile A while serving profile B' },
    selectedTopology: 'per_profile', profiles: [...profiles], sequential: 'pass', concurrent: 'pass', historyIsolation: 'pass',
    providerContextIsolation: 'pass', stateDatabaseIsolation: 'pass', restartIsolation: 'pass', crossKeyDenial: 'pass',
    bundledSkills: 'pass', dangerousToolsDisabled: 'pass', stop: 'pass', testedAt: new Date().toISOString(),
  };
  await writeFile('docs/hermes-capability-results.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await Promise.all(gateways.map(stopGateway));
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  if (!process.env.KEEP_HERMES_CAPABILITY_HOME) await rm(home, { recursive: true, force: true });
  else process.stdout.write(`Preserved test home: ${home}\n`);
}
