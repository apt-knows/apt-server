import { describe, expect, it } from 'vitest';
import { hermesApiKey, parseHermesFrame } from '../src/agent-runtime.js';

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
});
