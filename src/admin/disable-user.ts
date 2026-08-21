import { argument, adminService } from './cli.js';

const userId = argument('--user-id')!;
const { repository, service } = adminService();
try {
  await service.disable(userId);
  process.stdout.write(`Disabled Apt chat for ${userId}.\n`);
} finally { await repository.close(); }
