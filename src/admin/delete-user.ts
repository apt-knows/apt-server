import { argument, adminService } from './cli.js';

const userId = argument('--user-id')!;
const confirmation = argument('--confirm')!;
const { repository, service } = adminService();
try {
  await service.delete(userId, confirmation);
  process.stdout.write(`Deleted Apt chat records and Hermes profile for ${userId}.\n`);
} finally { await repository.close(); }
