import { describe, expect, it } from 'vitest';
import { hermesApiKey, HermesAgentRuntime, parseHermesFrame } from '../src/agent-runtime.js';
import { instance } from './fixtures.js';

describe('Hermes adapter', () => {
  it('derives isolated stable keys per profile', () => {
    const secret = 's'.repeat(32);
    expect(hermesApiKey('profile-a', secret)).toBe(hermesApiKey('profile-a', secret));
    expect(hermesApiKey('profile-a', secret)).not.toBe(hermesApiKey('profile-b', secret));
    expect(hermesApiKey('profile-a', secret)).not.toContain(secret);
  });

  it('parses only the public event subset', () => {
    expect(parseHermesFrame('event: message.delta\ndata: {"event":"message.delta","delta":"hi","secret":"no"}')).toEqual({ type: 'delta', delta: 'hi' });
    expect(parseHermesFrame('data: {"event":"tool.call","command":"rm -rf /"}')).toBeNull();
    expect(parseHermesFrame('data: {"event":"run.completed","output":"done"}')).toEqual({ type: 'completed', output: 'done' });
    expect(parseHermesFrame('data: not-json')).toBeNull();
  });

  it('routes local per-profile gateways through the explicit URL map', async () => {
    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input) => {
      requestedUrls.push(String(input));
      if (String(input).includes('/messages?')) {
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ run_id: 'hermes-run' }), { status: 202, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const runtime = new HermesAgentRuntime({
        baseUrl: 'http://127.0.0.1:8642', topology: 'per_profile',
        profileUrlTemplate: 'http://hermes-{profile}:8642',
        profileUrls: { [instance.hermesProfileName]: 'http://127.0.0.1:8643/' }, keySecret: 's'.repeat(32),
      });
      await runtime.submit(instance, 'hello');
      expect(requestedUrls).toEqual([
        `http://127.0.0.1:8643/api/sessions/${instance.hermesSessionId}/messages?limit=500&order=latest`,
        'http://127.0.0.1:8643/v1/runs',
      ]);
    } finally { globalThis.fetch = originalFetch; }
  });

  it('hydrates Runs API submissions with persisted Hermes conversation history', async () => {
    const originalFetch = globalThis.fetch;
    let submittedBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input, init) => {
      if (String(input).includes('/messages?')) {
        return new Response(JSON.stringify({ data: [
          { role: 'user', content: 'remember blue' },
          { role: 'assistant', content: 'blue' },
          { role: 'tool', content: 'private tool output' },
        ] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ run_id: 'hermes-run' }), { status: 202, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const runtime = new HermesAgentRuntime({
        baseUrl: 'http://127.0.0.1:8642', topology: 'per_profile',
        profileUrlTemplate: 'http://127.0.0.1:8642', keySecret: 's'.repeat(32),
      });
      await runtime.submit(instance, 'what color?');
      expect(submittedBody).toEqual({
        input: 'what color?',
        session_id: instance.hermesSessionId,
        conversation_history: [
          { role: 'user', content: 'remember blue' },
          { role: 'assistant', content: 'blue' },
        ],
      });
    } finally { globalThis.fetch = originalFetch; }
  });

  it('fails closed when Hermes omits persisted session history', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ object: 'list' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    try {
      const runtime = new HermesAgentRuntime({
        baseUrl: 'http://127.0.0.1:8642', topology: 'per_profile',
        profileUrlTemplate: 'http://127.0.0.1:8642', keySecret: 's'.repeat(32),
      });
      await expect(runtime.submit(instance, 'hello')).rejects.toThrow('Hermes did not return session history.');
    } finally { globalThis.fetch = originalFetch; }
  });
});
