import { HermesAgentRuntime } from './agent-runtime.js';
import { buildApp } from './app.js';
import { SupabaseAuthService } from './auth.js';
import { loadConfig } from './config.js';
import { PostgresChatRepository } from './repository.js';
import { ClawMaterializer } from './claw/materializer.js';
import { PostgresClawRepository } from './claw/repository.js';
import { ClawService } from './claw/service.js';
import { ClawAgentRuntime } from './claw/runtime.js';
import { PostgresShoppingRepository } from './shopping/repository.js';
import { ShoppingService } from './shopping/service.js';

const config = loadConfig();
const repository = PostgresChatRepository.create(config.supabase.databaseUrl, config.supabase.databaseSsl);
const auth = SupabaseAuthService.create(config.supabase.url, config.supabase.publishableKey);
const clawRepository = PostgresClawRepository.create(config.supabase.databaseUrl, config.supabase.databaseSsl);
const shoppingRepository = PostgresShoppingRepository.create(config.supabase.databaseUrl, config.supabase.databaseSsl);
const shoppingService = new ShoppingService(shoppingRepository);
const clawService = new ClawService(clawRepository, shoppingService);
const runtime = new ClawAgentRuntime(
  new HermesAgentRuntime(config.hermes),
  clawService,
  new ClawMaterializer(config.hermes.home),
);
const app = await buildApp({ config, repository, auth, runtime, clawService, shoppingService });
app.addHook('onClose', async () => clawRepository.close());
app.addHook('onClose', async () => shoppingRepository.close());

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
