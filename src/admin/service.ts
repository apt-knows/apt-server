import { createHmac } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { access, chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { createClient } from '@supabase/supabase-js';
import { hermesApiKey } from '../agent-runtime.js';
import { aptBridgeToken } from '../claw/bridge-auth.js';
import type { AppConfig } from '../config.js';
import type { AgentInstance } from '../domain.js';
import { AppError } from '../errors.js';
import type { ChatRepository } from '../repository.js';

const execFileAsync = promisify(execFile);

export interface HermesProfileAdmin {
  exists(profileName: string): Promise<boolean>;
  create(profileName: string): Promise<void>;
  configure(profileName: string): Promise<void>;
  validate(profileName: string, sessionId: string): Promise<void>;
  delete(profileName: string): Promise<void>;
}

export interface AuthAdmin {
  requireUser(userId: string): Promise<void>;
}

export function profileIdentity(userId: string, secret: string) {
  const digest = createHmac('sha256', secret).update(`apt-profile:${userId}`).digest('hex');
  const sessionHex = createHmac('sha256', secret).update(`apt-session:${userId}`).digest('hex').slice(0, 32);
  const sessionId = `${sessionHex.slice(0, 8)}-${sessionHex.slice(8, 12)}-4${sessionHex.slice(13, 16)}-a${sessionHex.slice(17, 20)}-${sessionHex.slice(20, 32)}`;
  return { profileName: `apt-${digest.slice(0, 20)}`, sessionId };
}

export class SupabaseUserAdmin implements AuthAdmin {
  private constructor(private readonly client: ReturnType<typeof createClient>) {}

  static create(url: string, serviceRoleKey: string) {
    return new SupabaseUserAdmin(createClient(url, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    }));
  }

  async requireUser(userId: string) {
    const { data, error } = await this.client.auth.admin.getUserById(userId);
    if (error || !data.user) throw new AppError('UNAUTHENTICATED', `Supabase user ${userId} does not exist.`);
  }
}

export class HermesCliProfileAdmin implements HermesProfileAdmin {
  constructor(private readonly config: AppConfig['hermes']) {}

  private profileDir(profileName: string) {
    if (!/^apt-[a-f0-9]{20}$/.test(profileName)) throw new Error('Refusing an invalid Hermes profile name.');
    return `${this.config.home.replace(/\/$/, '')}/profiles/${profileName}`;
  }

  private async run(args: string[]) {
    await execFileAsync(this.config.cli, args, {
      env: { ...process.env, HERMES_HOME: this.config.home }, timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
  }

  async exists(profileName: string) {
    try { await access(this.profileDir(profileName)); return true; } catch { return false; }
  }

  async create(profileName: string) {
    await this.run(['profile', 'create', profileName, '--no-alias', '--no-skills', '--description', 'Private Apt beta commerce profile.']);
  }

  async configure(profileName: string) {
    const profileArgs = ['--profile', profileName, 'config', 'set'];
    const sharedSkills = `${this.profileDir(profileName)}/apt-shared-skills`;
    const bridgeSource = fileURLToPath(new URL('../claw/bridge-server.ts', import.meta.url));
    const bridgeCompiled = fileURLToPath(new URL('../claw/bridge-server.js', import.meta.url));
    const bridgeEntry = await firstAccessible([bridgeSource, bridgeCompiled]);
    const tsxLoader = fileURLToPath(new URL('../../node_modules/tsx/dist/loader.mjs', import.meta.url));
    const bridgeArgs = bridgeEntry.endsWith('.ts') ? ['--import', tsxLoader, bridgeEntry] : [bridgeEntry];
    const bridgeTools = [
      'apt_search_knowledge', 'apt_remember', 'apt_update_private_artifact',
      'apt_propose_shared_change', 'apt_previous_hunts', 'apt_commerce_hunt',
    ];
    const entries: [string, string][] = [
      ['model.default', this.config.model],
      ['model.provider', this.config.provider],
      ['model.api_key', `\${${this.config.providerKeyEnv}}`],
      ['platform_toolsets.api_server', '["memory","session_search","skills"]'],
      ['agent.disabled_toolsets', '["web","browser","terminal","file","code_execution","vision","video","image_gen","video_gen","bfl","x_search","tts","stt","todo","context_engine","clarify","delegation","cronjob","homeassistant","spotify","discord","discord_admin","yuanbao","computer_use"]'],
      ['memory.memory_enabled', 'true'],
      ['memory.user_profile_enabled', 'true'],
      ['memory.write_approval', 'false'],
      ['memory.memory_char_limit', '2200'],
      ['memory.user_char_limit', '1375'],
      ['skills.external_dirs', JSON.stringify([sharedSkills])],
      ['skills.guard_agent_created', 'true'],
      ['skills.write_approval', 'false'],
      ['auxiliary.background_review.enabled', 'true'],
      ['mcp_servers', JSON.stringify({
        apt: {
          command: process.execPath,
          args: bridgeArgs,
          env: { APT_INTERNAL_URL: '${APT_INTERNAL_URL}', APT_BRIDGE_TOKEN: '${APT_BRIDGE_TOKEN}' },
          tools: { include: bridgeTools },
          connect_timeout: 15,
          enabled: true,
        },
      })],
    ];
    if (this.config.providerBaseUrl) entries.push(['model.base_url', this.config.providerBaseUrl]);
    for (const [key, value] of entries) {
      await this.run([...profileArgs, ...(key === 'mcp_servers' ? ['--force'] : []), key, value]);
    }
    await this.run(['--profile', profileName, 'skills', 'opt-out', '--remove', '--yes']);
    await this.removeNonPrivateSkills(profileName);
    await this.upsertSecret(profileName, this.config.providerKeyEnv, this.config.providerApiKey);
    await this.upsertSecret(profileName, 'API_SERVER_KEY', hermesApiKey(profileName, this.config.keySecret));
    await this.upsertSecret(profileName, 'APT_INTERNAL_URL', this.config.internalUrl);
    await this.upsertSecret(profileName, 'APT_BRIDGE_TOKEN', aptBridgeToken(profileName, this.config.keySecret));
    await this.run(['--profile', profileName, 'config', 'check']);
    await this.run(['--profile', profileName, 'mcp', 'test', 'apt']);
  }

  async validate(profileName: string, sessionId: string) {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const key = hermesApiKey(profileName, this.config.keySecret);
    const child = spawn(this.config.cli, ['--profile', profileName, 'gateway', 'run', '--force', '--accept-hooks'], {
      env: {
        ...process.env,
        HERMES_HOME: this.config.home,
        API_SERVER_ENABLED: 'true',
        API_SERVER_HOST: '127.0.0.1',
        API_SERVER_PORT: String(port),
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let diagnostics = '';
    child.stderr?.on('data', (chunk) => { diagnostics = `${diagnostics}${String(chunk)}`.slice(-8_000); });
    try {
      await waitForGateway(child, baseUrl, () => diagnostics);
      const request = (path: string, init: RequestInit = {}) => fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(10_000),
      });
      const [capabilities, skills, toolsets] = await Promise.all([
        request('/v1/capabilities'), request('/v1/skills'), request('/v1/toolsets'),
      ]);
      if (!capabilities.ok || !skills.ok || !toolsets.ok) throw new Error('Hermes discovery validation failed.');
      await skills.json();
      const toolRows = rows(await toolsets.json(), 'toolsets') as Array<{ name?: string; key?: string; enabled?: boolean; tools?: unknown[] }>;
      const enabledToolsets = new Set(toolRows.filter((row) => row.enabled).map((row) => row.key ?? row.name).filter(Boolean));
      for (const required of ['memory', 'session_search', 'skills']) {
        if (!enabledToolsets.has(required)) throw new Error(`Hermes profile is missing required ${required} toolset.`);
      }
      const forbidden = [...enabledToolsets].filter((key) => !['memory', 'session_search', 'skills'].includes(String(key)));
      if (forbidden.length) throw new Error(`Hermes API server exposes forbidden toolsets: ${forbidden.join(', ')}.`);

      const submitted = await request('/v1/runs', {
        method: 'POST',
        body: JSON.stringify({ input: 'Reply with exactly: apt-provisioning-ok', session_id: sessionId }),
      });
      if (submitted.status !== 202) throw new Error(`Hermes validation turn returned ${submitted.status}.`);
      const runId = String(((await submitted.json()) as { run_id?: string }).run_id ?? '');
      if (!runId) throw new Error('Hermes validation turn did not return a run ID.');
      const settled = await waitForRun(request, runId);
      if (settled.status !== 'completed' || !settled.output?.trim()) {
        throw new Error(`Hermes validation turn settled as ${settled.status}.`);
      }
      const sessions = await request('/api/sessions');
      if (!sessions.ok || !(await sessions.text()).includes(sessionId)) {
        throw new Error('Hermes did not persist the configured session.');
      }
    } finally {
      await stopGateway(child);
    }
  }

  private async upsertSecret(profileName: string, key: string, value: string) {
    const directory = this.profileDir(profileName);
    const path = `${directory}/.env`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let lines: string[] = [];
    try { lines = (await readFile(path, 'utf8')).split(/\r?\n/); } catch { /* new profile env */ }
    const next = lines.filter((line) => line && !line.startsWith(`${key}=`));
    next.push(`${key}=${value}`);
    await writeFile(path, `${next.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
    await chmod(path, 0o600);
  }

  private async removeNonPrivateSkills(profileName: string) {
    const directory = `${this.profileDir(profileName)}/skills`;
    let entries: Dirent[] = [];
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.name.startsWith('private.')) await rm(`${directory}/${entry.name}`, { recursive: true, force: true });
    }
  }

  async delete(profileName: string) {
    if (await this.exists(profileName)) await this.run(['profile', 'delete', profileName, '--yes']);
  }
}

async function firstAccessible(paths: string[]) {
  for (const path of paths) {
    try { await access(path); return path; } catch { /* try compiled/source counterpart */ }
  }
  throw new Error('Apt Claw bridge entrypoint is missing.');
}

export class ProvisioningService {
  constructor(
    private readonly repository: ChatRepository,
    private readonly auth: AuthAdmin,
    private readonly hermes: HermesProfileAdmin,
    private readonly keySecret: string,
  ) {}

  async provision(userId: string): Promise<AgentInstance> {
    await this.auth.requireUser(userId);
    const identity = profileIdentity(userId, this.keySecret);
    const existing = await this.repository.getAgentInstance(userId);
    if (existing && (existing.hermesProfileName !== identity.profileName || existing.hermesSessionId !== identity.sessionId)) {
      throw new Error('Stored agent identity does not match the deterministic provisioning identity.');
    }
    const profileExists = await this.hermes.exists(identity.profileName);
    if (!profileExists) await this.hermes.create(identity.profileName);
    await this.hermes.configure(identity.profileName);
    await this.hermes.validate(identity.profileName, identity.sessionId);
    if (existing) return existing;
    return this.repository.upsertAgentInstance({ userId, hermesProfileName: identity.profileName, hermesSessionId: identity.sessionId });
  }

  async disable(userId: string) {
    return this.repository.disableAgentInstance(userId);
  }

  async delete(userId: string, confirmation: string) {
    if (confirmation !== userId) throw new Error('Deletion requires --confirm to exactly match the user ID.');
    const existing = await this.repository.getAgentInstance(userId);
    if (!existing) throw new AppError('AGENT_NOT_PROVISIONED', 'Apt chat has not been provisioned for this user.');
    await this.hermes.delete(existing.hermesProfileName);
    await this.repository.deleteUserRecords(userId);
  }
}

function rows(body: unknown, key: 'skills' | 'toolsets'): unknown[] {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  const object = body as Record<string, unknown>;
  const selected = object[key] ?? object.data;
  return Array.isArray(selected) ? selected : [];
}

async function reservePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not reserve a Hermes validation port.');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForGateway(child: ChildProcess, baseUrl: string, diagnostics: () => string) {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Hermes validation gateway exited with ${child.exitCode}: ${diagnostics()}`);
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch { /* gateway is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Hermes validation gateway did not become healthy: ${diagnostics()}`);
}

async function waitForRun(request: (path: string, init?: RequestInit) => Promise<Response>, runId: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await request(`/v1/runs/${encodeURIComponent(runId)}`);
    if (!response.ok) throw new Error(`Hermes validation status returned ${response.status}.`);
    const body = await response.json() as { status: string; output?: string };
    if (['completed', 'failed', 'cancelled'].includes(body.status)) return body;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Hermes validation turn did not settle in time.');
}

async function stopGateway(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
