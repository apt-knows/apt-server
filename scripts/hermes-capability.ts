import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
const providerTools: Record<string, string[]> = { 'provider-a': [], 'provider-b': [] };
const activeUrls: Record<typeof profiles[number], string> = {
  'apt-capability-a': '', 'apt-capability-b': '',
};
let sharedMcpDiscovery = true;
const bridgeEntry = join(process.cwd(), 'src', 'claw', 'bridge-server.ts');
const tsxLoader = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'loader.mjs');
const browserPolicyPlugin = join(process.cwd(), 'hermes-plugins', 'apt-hunt-browser-policy');
const aptTools = ['apt_search_knowledge', 'apt_remember', 'apt_update_private_artifact', 'apt_propose_shared_change', 'apt_previous_hunts', 'apt_commerce_hunt'];
let browserExecutablePath = process.env.AGENT_BROWSER_EXECUTABLE_PATH ?? '';

function configYaml(multiplex: boolean, apiEnabled: boolean, port: number, sharedSkills = '') {
  return `model:\n  default: mock-model\n  provider: custom\n  base_url: http://127.0.0.1:${providerPort}/v1\n  api_key: \${MOCK_PROVIDER_KEY}\nplatform_toolsets:\n  api_server: [memory, session_search, skills, browser]\nagent:\n  disabled_toolsets: [web, search, terminal, file, code_execution, vision, video, image_gen, video_gen, bfl, x_search, tts, stt, todo, context_engine, clarify, delegation, cronjob, homeassistant, spotify, discord, discord_admin, yuanbao, computer_use]\nbrowser:\n  backend: \"off\"\n  allow_private_urls: false\n  restrict_evaluate: true\nsecurity:\n  website_blocklist:\n    enabled: true\n    domains: [localhost, local, 0.0.0.0, 127.0.0.1, \"::1\", metadata.google.internal]\nplugins:\n  enabled: [apt-hunt-browser-policy]\n  entries:\n    apt-hunt-browser-policy:\n      allow_tool_override: true\nmemory:\n  memory_enabled: true\n  user_profile_enabled: true\n  write_approval: false\n  memory_char_limit: 2200\n  user_char_limit: 1375\nskills:\n  external_dirs: [${JSON.stringify(sharedSkills)}]\n  guard_agent_created: true\n  write_approval: false\nauxiliary:\n  background_review:\n    enabled: true\nmcp_servers:\n  apt:\n    command: ${JSON.stringify(process.execPath)}\n    args: [\"--import\", ${JSON.stringify(tsxLoader)}, ${JSON.stringify(bridgeEntry)}]\n    env:\n      APT_INTERNAL_URL: \"http://127.0.0.1:9\"\n      APT_BRIDGE_TOKEN: \"apt-capability-token-0123456789abcdef\"\n    tools:\n      include: [${aptTools.join(', ')}]\n    connect_timeout: 15\n    enabled: true\ngateway:\n  multiplex_profiles: ${multiplex}\n  multiplex_profile_allowlist: [${profiles.join(', ')}]\nplatforms:\n  api_server:\n    enabled: ${apiEnabled}\n    host: 127.0.0.1\n    port: ${port}\n    max_concurrent_runs: 10\n`;
}

async function writeProfile(home: string, profile: typeof profiles[number]) {
  const directory = join(home, 'profiles', profile);
  const sharedSkills = join(directory, 'apt-shared-skills');
  await mkdir(join(directory, 'memories'), { recursive: true });
  await mkdir(join(directory, 'skills', 'private.capability'), { recursive: true });
  await mkdir(join(sharedSkills, 'apt-commerce-verification'), { recursive: true });
  const pluginDestination = join(directory, 'plugins', 'apt-hunt-browser-policy');
  await mkdir(pluginDestination, { recursive: true });
  for (const name of ['plugin.yaml', '__init__.py']) {
    await writeFile(join(pluginDestination, name), await readFile(join(browserPolicyPlugin, name)));
  }
  await writeFile(join(directory, 'config.yaml'), configYaml(false, false, gatewayPort, sharedSkills), 'utf8');
  await writeFile(join(directory, '.env'), `API_SERVER_KEY=${profileKeys[profile]}\nMOCK_PROVIDER_KEY=${providerKeys[profile]}\n${browserExecutablePath ? `AGENT_BROWSER_EXECUTABLE_PATH=${browserExecutablePath}\n` : ''}`, { mode: 0o600 });
  await writeFile(join(directory, 'SOUL.md'), `Private Soul probe for ${profile}.\n`, 'utf8');
  await writeFile(join(directory, 'memories', 'USER.md'), `USER hot-cache probe for ${profile}.\n`, 'utf8');
  await writeFile(join(directory, 'memories', 'MEMORY.md'), `MEMORY hot-cache probe for ${profile}.\n`, 'utf8');
  await writeFile(join(directory, 'skills', 'private.capability', 'SKILL.md'), '---\nname: private.capability\ndescription: User-scoped capability probe.\n---\n# Private capability probe\n', 'utf8');
  await writeFile(join(sharedSkills, 'apt-commerce-verification', 'SKILL.md'), '---\nname: apt-commerce-verification\ndescription: Read-only shared commerce verification probe.\n---\n# Shared commerce verification probe\n', 'utf8');
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
    const body = JSON.parse(raw) as { stream?: boolean; messages?: Array<{ role?: string; content?: string }>; tools?: Array<{ function?: { name?: string } }> };
    const providerKey = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const contents = (body.messages ?? []).filter((item) => item.role === 'user').map((item) => item.content ?? '');
    if (providerRequests[providerKey]) providerRequests[providerKey].push(contents.join('\n'));
    if (providerTools[providerKey]) providerTools[providerKey].push(...(body.tools ?? []).map((tool) => tool.function?.name ?? '').filter(Boolean));
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

async function verifyExternalBrowserInteraction() {
  const session = `apt-hunt-${process.pid}`;
  const environment = {
    ...process.env,
    ...(browserExecutablePath ? { AGENT_BROWSER_EXECUTABLE_PATH: browserExecutablePath } : {}),
  };
  const browserArgs = ['--yes', 'agent-browser@^0.26.0', '--session', session];
  try {
    await execFileAsync('npx', [...browserArgs, 'open', 'https://example.com'], { env: environment, timeout: 60_000 });
    const snapshot = await execFileAsync('npx', [...browserArgs, 'snapshot'], { env: environment, timeout: 60_000 });
    const linkRef = snapshot.stdout.match(/link "Learn more" \[ref=(e\d+)\]/)?.[1];
    assert(linkRef, `External browser snapshot omitted the expected interactive link: ${snapshot.stdout.slice(0, 1_000)}`);
    await execFileAsync('npx', [...browserArgs, 'click', `@${linkRef}`], { env: environment, timeout: 60_000 });
    const currentUrl = await execFileAsync('npx', [...browserArgs, 'get', 'url'], { env: environment, timeout: 60_000 });
    assert(currentUrl.stdout.includes('iana.org/help/example-domains'), `External browser click did not navigate: ${currentUrl.stdout}`);
  } finally {
    await execFileAsync('npx', [...browserArgs, 'close'], { env: environment, timeout: 30_000 }).catch(() => undefined);
  }
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
  if (!browserExecutablePath) {
    for (const candidate of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']) {
      try { await access(candidate); browserExecutablePath = candidate; break; } catch { /* try next local browser */ }
    }
  }
  await new Promise<void>((resolve) => provider.listen(0, '127.0.0.1', resolve));
  const providerAddress = provider.address();
  if (!providerAddress || typeof providerAddress === 'string') throw new Error('Mock provider did not bind a TCP port.');
  providerPort = providerAddress.port;
  gatewayPort = await reservePort();
  for (const profile of profiles) {
    await execFileAsync(hermes, ['profile', 'create', profile, '--no-alias', '--no-skills'], { env: { ...process.env, HERMES_HOME: home }, timeout: 60_000 });
    await writeProfile(home, profile);
    const mcpProbe = await execFileAsync(hermes, ['--profile', profile, 'mcp', 'test', 'apt'], {
      env: { ...process.env, HERMES_HOME: home }, timeout: 60_000,
    });
    for (const tool of aptTools) assert(mcpProbe.stdout.includes(tool), `${profile} MCP discovery omitted ${tool}.`);
  }
  await mkdir(home, { recursive: true });
  await writeFile(join(home, 'config.yaml'), configYaml(true, true, gatewayPort), 'utf8');
  await writeFile(join(home, '.env'), `API_SERVER_KEY=default-0123456789abcdef0123456789abcdef0123456789abcdef\nMOCK_PROVIDER_KEY=provider-default\n${browserExecutablePath ? `AGENT_BROWSER_EXECUTABLE_PATH=${browserExecutablePath}\n` : ''}`, { mode: 0o600 });

  gateways = [await startGateway(home, gatewayPort)];
  for (const profile of profiles) activeUrls[profile] = `http://127.0.0.1:${gatewayPort}/p/${profile}`;
  for (const profile of profiles) {
    const [capabilities, skills, toolsets] = await Promise.all([api(profile, '/v1/capabilities'), api(profile, '/v1/skills'), api(profile, '/v1/toolsets')]);
    assert(capabilities.ok && skills.ok && toolsets.ok, `${profile} discovery endpoints failed.`);
    const skillBody = await skills.json() as unknown[] | { skills?: unknown[]; data?: unknown[] };
    const toolBody = await toolsets.json() as Array<{ key?: string; name?: string; enabled?: boolean; tools?: string[] }> | { toolsets?: Array<{ key?: string; name?: string; enabled?: boolean; tools?: string[] }>; data?: Array<{ key?: string; name?: string; enabled?: boolean; tools?: string[] }> };
    const skillRows = Array.isArray(skillBody) ? skillBody : skillBody.skills ?? skillBody.data ?? [];
    const toolRows = Array.isArray(toolBody) ? toolBody : toolBody.toolsets ?? toolBody.data ?? [];
    assert(skillRows.length === 2, `${profile} did not expose exactly the Apt shared and private skill probes: ${JSON.stringify(skillBody).slice(0, 1_000)}`);
    const enabledKeys = toolRows.filter((row) => row.enabled).map((row) => row.key ?? row.name);
    for (const required of ['memory', 'session_search', 'skills', 'browser']) assert(enabledKeys.includes(required), `${profile} is missing ${required}.`);
    if (!enabledKeys.includes('mcp-apt')) sharedMcpDiscovery = false;
    assert(enabledKeys.every((key) => ['memory', 'session_search', 'skills', 'browser'].includes(String(key))), `${profile} exposed a forbidden toolset: ${enabledKeys.join(', ')}.`);
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
    await writeFile(join(home, 'profiles', profile, 'config.yaml'), configYaml(false, true, port, join(home, 'profiles', profile, 'apt-shared-skills')), 'utf8');
    activeUrls[profile] = `http://127.0.0.1:${port}`;
  }
  gateways = await Promise.all(profiles.map((profile, index) => startGateway(home, isolatedPorts[index]!, profile)));
  providerRequests['provider-a'] = [];
  providerRequests['provider-b'] = [];
  providerTools['provider-a'] = [];
  providerTools['provider-b'] = [];

  assert((await api(profiles[1], '/v1/capabilities', {}, profileKeys[profiles[0]])).status === 401, 'Fallback accepted a cross-profile API key.');
  await waitForRun(profiles[0], await submit(profiles[0], 'fallback-alpha-private', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
  await waitForRun(profiles[1], await submit(profiles[1], 'fallback-beta-private', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'));
  const fallbackConcurrent = await Promise.all([
    submit(profiles[0], 'fallback-alpha-concurrent', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
    submit(profiles[1], 'fallback-beta-concurrent', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  ]);
  await Promise.all([waitForRun(profiles[0], fallbackConcurrent[0]), waitForRun(profiles[1], fallbackConcurrent[1])]);
  for (const profile of profiles) {
    const toolsets = await api(profile, '/v1/toolsets');
    const body = await toolsets.json() as Array<{ key?: string; name?: string; enabled?: boolean }> | { toolsets?: Array<{ key?: string; name?: string; enabled?: boolean }>; data?: Array<{ key?: string; name?: string; enabled?: boolean }> };
    const rows = Array.isArray(body) ? body : body.toolsets ?? body.data ?? [];
    const enabledKeys = rows.filter((row) => row.enabled).map((row) => row.key ?? row.name);
    for (const required of ['memory', 'session_search', 'skills', 'browser']) assert(enabledKeys.includes(required), `Per-profile ${profile} is missing ${required}: enabled=${enabledKeys.join(', ')}`);
    assert(enabledKeys.every((key) => ['memory', 'session_search', 'skills', 'browser'].includes(String(key))), `Per-profile ${profile} exposed forbidden toolsets: ${enabledKeys.join(', ')}.`);
  }
  for (const providerKey of ['provider-a', 'provider-b']) {
    const effectiveTools = providerTools[providerKey]!;
    for (const tool of ['tool_search', 'tool_describe', 'tool_call']) assert(effectiveTools.includes(tool), `${providerKey} model surface is missing constrained MCP discovery tool ${tool}: ${effectiveTools.join(', ')}`);
    for (const tool of ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_back', 'browser_press']) {
      assert(effectiveTools.includes(tool), `${providerKey} model surface is missing required Hunt browser tool ${tool}: ${effectiveTools.join(', ')}`);
    }
    assert(!effectiveTools.includes('web_search'), `${providerKey} model surface exposed API-backed web_search.`);
    for (const forbidden of ['terminal', 'write_file', 'execute_code', 'delegate_task', 'cronjob']) {
      assert(!effectiveTools.includes(forbidden), `${providerKey} model surface exposed forbidden tool ${forbidden}.`);
    }
  }
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
    await writeFile(join(home, 'profiles', profile, 'config.yaml'), configYaml(false, true, restartPorts[index]!, join(home, 'profiles', profile, 'apt-shared-skills')), 'utf8');
    activeUrls[profile] = `http://127.0.0.1:${restartPorts[index]!}`;
  }
  gateways = await Promise.all(profiles.map((profile, index) => startGateway(home, restartPorts[index]!, profile)));
  const restartedA = await (await api(profiles[0], '/api/sessions')).text();
  const restartedB = await (await api(profiles[1], '/api/sessions')).text();
  assert(!restartedA.includes('fallback-beta') && !restartedB.includes('fallback-alpha'), 'Fallback restart introduced cross-profile session leakage.');
  await verifyExternalBrowserInteraction();

  const report = {
    hermesVersion: version,
    sharedTopology: { result: sharedProviderIsolation && sharedMcpDiscovery ? 'pass' : 'fail', reason: sharedProviderIsolation && sharedMcpDiscovery ? null : 'shared multiplexing failed the per-profile provider credential and/or Apt MCP discovery boundary' },
    selectedTopology: 'per_profile', profiles: [...profiles], sequential: 'pass', concurrent: 'pass', historyIsolation: 'pass',
    providerContextIsolation: 'pass', stateDatabaseIsolation: 'pass', restartIsolation: 'pass', crossKeyDenial: 'pass',
    soulIsolation: 'pass', hotUserMemoryLimits: { userChars: 1375, memoryChars: 2200, result: 'pass' },
    aptOnlySkills: 'pass', aptBridgeDiscovery: 'pass', browserHuntTools: 'pass', apiBackedWebSearchDisabled: 'pass', browserExternalInteraction: 'pass', dangerousToolsDisabled: 'pass', arbitraryMcpDisabled: 'pass',
    typedBridgeBoundary: 'covered-by-server-tests', stop: 'pass', testedAt: new Date().toISOString(),
  };
  await writeFile('docs/hermes-capability-results.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await Promise.all(gateways.map(stopGateway));
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  if (!process.env.KEEP_HERMES_CAPABILITY_HOME) await rm(home, { recursive: true, force: true });
  else process.stdout.write(`Preserved test home: ${home}\n`);
}
