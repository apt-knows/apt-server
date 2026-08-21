import { z } from 'zod';

const booleanFromString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const configuredValue = z.string().min(1).refine(
  (value) => !value.includes('__REQUIRES_'),
  'Replace the local setup marker with the real secret or provider value.',
);

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  LOG_LEVEL: z.string().default('info'),
  APT_ALLOWED_ORIGINS: z.string().default(''),
  SUPABASE_URL: z.url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: configuredValue.pipe(z.string().min(20)),
  SUPABASE_DATABASE_URL: configuredValue,
  SUPABASE_DATABASE_SSL: booleanFromString,
  HERMES_VERSION: z.string().default('v2026.8.19'),
  HERMES_BASE_URL: z.url().default('http://127.0.0.1:8642'),
  HERMES_TOPOLOGY: z.enum(['shared', 'per_profile']).default('per_profile'),
  HERMES_PROFILE_URL_TEMPLATE: z.string().default('http://hermes-{profile}:8642'),
  HERMES_KEY_SECRET: z.string().min(32),
  HERMES_HOME: z.string().default('/var/lib/hermes'),
  HERMES_CLI: z.string().default('hermes'),
  HERMES_PROVIDER: z.string().default('custom'),
  HERMES_MODEL: configuredValue,
  HERMES_PROVIDER_BASE_URL: z.url().optional(),
  HERMES_PROVIDER_KEY_ENV: z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('OPENAI_API_KEY'),
  HERMES_PROVIDER_API_KEY: configuredValue,
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = configSchema.parse(environment);
  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    allowedOrigins: parsed.APT_ALLOWED_ORIGINS.split(',').map((item) => item.trim()).filter(Boolean),
    supabase: {
      url: parsed.SUPABASE_URL,
      publishableKey: parsed.SUPABASE_PUBLISHABLE_KEY,
      serviceRoleKey: parsed.SUPABASE_SERVICE_ROLE_KEY,
      databaseUrl: parsed.SUPABASE_DATABASE_URL,
      databaseSsl: parsed.SUPABASE_DATABASE_SSL,
    },
    hermes: {
      version: parsed.HERMES_VERSION,
      baseUrl: parsed.HERMES_BASE_URL.replace(/\/$/, ''),
      topology: parsed.HERMES_TOPOLOGY,
      profileUrlTemplate: parsed.HERMES_PROFILE_URL_TEMPLATE,
      keySecret: parsed.HERMES_KEY_SECRET,
      home: parsed.HERMES_HOME,
      cli: parsed.HERMES_CLI,
      provider: parsed.HERMES_PROVIDER,
      model: parsed.HERMES_MODEL,
      providerBaseUrl: parsed.HERMES_PROVIDER_BASE_URL,
      providerKeyEnv: parsed.HERMES_PROVIDER_KEY_ENV,
      providerApiKey: parsed.HERMES_PROVIDER_API_KEY,
    },
  } as const;
}
