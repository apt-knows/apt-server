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
    let requestedUrl = '';
    globalThis.fetch = (async (input) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({ run_id: 'hermes-run' }), { status: 202, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    try {
      const runtime = new HermesAgentRuntime({
        baseUrl: 'http://127.0.0.1:8642', topology: 'per_profile',
        profileUrlTemplate: 'http://hermes-{profile}:8642',
        profileUrls: { [instance.hermesProfileName]: 'http://127.0.0.1:8643/' }, keySecret: 's'.repeat(32),
      });
      await runtime.submit(instance, 'hello');
      expect(requestedUrl).toBe('http://127.0.0.1:8643/v1/runs');
    } finally { globalThis.fetch = originalFetch; }
  });
});
