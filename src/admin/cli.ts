import { loadConfig } from '../config.js';
import { PostgresChatRepository } from '../repository.js';
import { HermesCliProfileAdmin, ProvisioningService, SupabaseUserAdmin } from './service.js';

export function argument(name: string, required = true) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required && !value) throw new Error(`Missing required ${name} argument.`);
  return value;
}

export function adminService() {
  const config = loadConfig();
  const repository = PostgresChatRepository.create(config.supabase.databaseUrl, config.supabase.databaseSsl);
  const auth = SupabaseUserAdmin.create(config.supabase.url, config.supabase.serviceRoleKey);
  const hermes = new HermesCliProfileAdmin(config.hermes);
  return { repository, service: new ProvisioningService(repository, auth, hermes, config.hermes.keySecret) };
}
