import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { AppError } from '../src/errors.js';
import { auth, config, repository, RUN_ID, runtime, USER_A, USER_B } from './fixtures.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

async function appWith(repositoryOverrides = {}) {
  const repo = repository(repositoryOverrides);
  const app = await buildApp({ config, auth: auth(), repository: repo, runtime: runtime() });
  apps.push(app);
  await app.ready();
  return { app, repo };
}

describe('chat API', () => {
  it('requires a valid bearer token on every chat route', async () => {
    const { app } = await appWith();
    for (const request of [
      { method: 'GET', url: '/v1/chat' },
      { method: 'POST', url: '/v1/chat/messages', payload: {} },
      { method: 'GET', url: `/v1/chat/runs/${RUN_ID}` },
      { method: 'GET', url: `/v1/chat/runs/${RUN_ID}/events` },
      { method: 'POST', url: `/v1/chat/runs/${RUN_ID}/stop` },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('scopes history reads to the authenticated user and accepts keyset parameters', async () => {
    const getChat = vi.fn(async () => ({ messages: [], olderCursor: '10', activeRun: null }));
    const { app } = await appWith({ getChat });
    const response = await app.inject({ method: 'GET', url: '/v1/chat?before=42&limit=25', headers: { authorization: 'Bearer token-a' } });
    expect(response.statusCode).toBe(200);
    expect(getChat).toHaveBeenCalledWith(USER_A, '42', 25);
  });

  it('returns a stable error when the user is not provisioned', async () => {
    const { app } = await appWith({ getAgentInstance: vi.fn(async () => null) });
    const response = await app.inject({ method: 'POST', url: '/v1/chat/messages', headers: { authorization: 'Bearer token-a' },
      payload: { clientMessageId: '77777777-7777-4777-8777-777777777777', content: 'hello' } });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: { code: 'AGENT_NOT_PROVISIONED', message: 'Apt chat has not been provisioned for this user.' } });
  });

  it('normalizes a message and preserves the idempotency key', async () => {
    const createTurn = vi.fn(async () => (await import('./fixtures.js')).turn());
    const { app } = await appWith({ createTurn });
    const response = await app.inject({ method: 'POST', url: '/v1/chat/messages', headers: { authorization: 'Bearer token-a' },
      payload: { clientMessageId: '77777777-7777-4777-8777-777777777777', content: '  hello\r\nworld  ' } });
    expect(response.statusCode).toBe(202);
    expect(createTurn).toHaveBeenCalledWith(USER_A, '77777777-7777-4777-8777-777777777777', 'hello\nworld');
  });

  it('does not reveal another user\'s run or event stream', async () => {
    const getRun = vi.fn(async (userId: string) => {
      if (userId === USER_B) throw new AppError('RUN_NOT_FOUND', 'Run not found.');
      return (await import('./fixtures.js')).run();
    });
    const { app } = await appWith({ getRun });
    for (const suffix of ['', '/events']) {
      const response = await app.inject({ method: 'GET', url: `/v1/chat/runs/${RUN_ID}${suffix}`, headers: { authorization: 'Bearer token-b' } });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('RUN_NOT_FOUND');
    }
  });

  it('emits only sanitized application events for a terminal run', async () => {
    const { app } = await appWith();
    const response = await app.inject({ method: 'GET', url: `/v1/chat/runs/${RUN_ID}/events`, headers: { authorization: 'Bearer token-a' } });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('event: run.snapshot');
    expect(response.body).not.toContain('hermesProfileName');
  });
});
