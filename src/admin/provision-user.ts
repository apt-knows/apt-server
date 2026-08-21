import { argument, adminService } from './cli.js';

const userId = argument('--user-id')!;
const { repository, service } = adminService();
try {
  const instance = await service.provision(userId);
  process.stdout.write(`Provisioned ${instance.userId} as ${instance.hermesProfileName}.\n`);
} finally { await repository.close(); }
