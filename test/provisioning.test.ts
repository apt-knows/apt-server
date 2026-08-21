import { describe, expect, it, vi } from 'vitest';
import { profileIdentity, ProvisioningService, type HermesProfileAdmin } from '../src/admin/service.js';
import { instance, repository, USER_A } from './fixtures.js';

function hermes(exists = false): HermesProfileAdmin {
  return { exists: vi.fn(async () => exists), create: vi.fn(async () => undefined), configure: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) };
}

describe('manual provisioning lifecycle', () => {
  it('derives stable opaque profile and session identifiers', () => {
    const first = profileIdentity(USER_A, 's'.repeat(32));
    expect(first).toEqual(profileIdentity(USER_A, 's'.repeat(32)));
    expect(first.profileName).not.toContain(USER_A);
    expect(first.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('is idempotent and retains bundled profile skills', async () => {
    const repo = repository({ getAgentInstance: vi.fn(async () => null) });
    const profiles = hermes(false);
    const service = new ProvisioningService(repo, { requireUser: vi.fn(async () => undefined) }, profiles, 's'.repeat(32));
    await service.provision(USER_A);
    expect(profiles.create).toHaveBeenCalledOnce();
    expect(profiles.configure).toHaveBeenCalledOnce();
    expect(repo.upsertAgentInstance).toHaveBeenCalledOnce();
  });

  it('requires exact confirmation and deletes Hermes before database records', async () => {
    const order: string[] = [];
    const repo = repository({ getAgentInstance: vi.fn(async () => instance), deleteUserRecords: vi.fn(async () => { order.push('database'); }) });
    const profiles = hermes(true);
    vi.mocked(profiles.delete).mockImplementation(async () => { order.push('hermes'); });
    const service = new ProvisioningService(repo, { requireUser: vi.fn(async () => undefined) }, profiles, 's'.repeat(32));
    await expect(service.delete(USER_A, 'wrong')).rejects.toThrow('exactly match');
    await service.delete(USER_A, USER_A);
    expect(order).toEqual(['hermes', 'database']);
  });
});
