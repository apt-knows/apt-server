import { describe, expect, it } from 'vitest';
import { bearerToken } from '../src/auth.js';

describe('bearerToken', () => {
  it('accepts a case-insensitive bearer scheme', () => expect(bearerToken('bearer token')).toBe('token'));
  it.each([undefined, '', 'Basic token', 'Bearer '])('rejects an invalid header', (header) => {
    expect(() => bearerToken(header)).toThrowError(expect.objectContaining({ code: 'UNAUTHENTICATED' }));
  });
});
