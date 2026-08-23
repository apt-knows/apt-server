import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const required = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'publishable-key-for-tests',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key-for-tests',
  SUPABASE_DATABASE_URL: 'postgresql://example',
  HERMES_KEY_SECRET: 'x'.repeat(32),
  HERMES_MODEL: 'test-model',
  HERMES_PROVIDER_API_KEY: 'test-key',
};

describe('Hermes provider configuration', () => {
  it('defaults to the direct OpenAI API provider', () => {
    expect(loadConfig(required).hermes.provider).toBe('openai-api');
  });

  it('requires an explicit endpoint for the custom provider', () => {
    expect(() => loadConfig({ ...required, HERMES_PROVIDER: 'custom' })).toThrow(
      'HERMES_PROVIDER_BASE_URL is required when HERMES_PROVIDER=custom.',
    );
  });

  it('accepts a custom provider with an explicit endpoint', () => {
    const config = loadConfig({
      ...required,
      HERMES_PROVIDER: 'custom',
      HERMES_PROVIDER_BASE_URL: 'http://127.0.0.1:9999/v1',
    });
    expect(config.hermes.providerBaseUrl).toBe('http://127.0.0.1:9999/v1');
  });
});

describe('commerce provider configuration', () => {
  it('requires an HTTPS endpoint and API key together', () => {
    expect(() => loadConfig({ ...required, COMMERCE_SEARCH_ENDPOINT: 'https://commerce.example/search' })).toThrow(
      'must be configured together',
    );
    expect(() => loadConfig({
      ...required,
      COMMERCE_SEARCH_ENDPOINT: 'http://commerce.example/search',
      COMMERCE_SEARCH_API_KEY: 'commerce-key',
    })).toThrow('must use HTTPS');
  });

  it('accepts a complete HTTPS commerce provider', () => {
    const config = loadConfig({
      ...required,
      COMMERCE_SEARCH_ENDPOINT: 'https://commerce.example/search',
      COMMERCE_SEARCH_API_KEY: 'commerce-key',
    });
    expect(config.commerce.endpoint).toBe('https://commerce.example/search');
  });
});
