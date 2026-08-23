import { describe, expect, it, vi } from 'vitest';
import { aptBridgeToken, verifyAptBridgeToken } from '../src/claw/bridge-auth.js';
import {
  capabilityChecksum,
  compileClawTurn,
  documentChecksum,
  sha256,
  type CompiledClawTurn,
} from '../src/claw/compiler.js';
import { HttpCommerceSearchAdapter, isPrivateAddress } from '../src/claw/commerce.js';
import type {
  ClawCapability,
  ClawDocument,
  ClawTurnBundle,
  ForegroundLocation,
  ProductCandidate,
} from '../src/claw/domain.js';
import { boundRecentMessages, type ClawRepository } from '../src/claw/repository.js';
import { ClawService } from '../src/claw/service.js';
import { profileIdentity } from '../src/admin/service.js';
import type { AgentInstance } from '../src/domain.js';

function bundle(privateFact = 'private-fact'): ClawTurnBundle {
  const documentDefinitions: Array<[string, ClawDocument['kind']]> = [
    ['core.identity', 'core'], ['soul.default', 'soul_template'], ['policy.boundary', 'policy'],
    ['intent.retail', 'intent'], ['intent.grocery', 'intent'], ['intent.food', 'intent'],
  ];
  const documentInputs: Array<Omit<ClawDocument, 'checksum'>> = documentDefinitions
    .map(([key, kind]) => ({ key, kind, title: key, content: `content:${key}`, enabled: true, metadata: {} }));
  const documents = documentInputs.map((document) => ({ ...document, checksum: documentChecksum(document) }));
  const capabilityInputs: Array<Omit<ClawCapability, 'checksum'>> = [
    { key: 'memory', kind: 'toolset', enabled: true, config: {}, instructions: '', secretRefs: [] },
    { key: 'session_search', kind: 'toolset', enabled: true, config: {}, instructions: '', secretRefs: [] },
    { key: 'skills', kind: 'toolset', enabled: true, config: {}, instructions: '', secretRefs: [] },
    { key: 'apt_bridge', kind: 'mcp', enabled: true, config: {}, instructions: '', secretRefs: ['APT_BRIDGE_TOKEN'] },
  ];
  const capabilities = capabilityInputs.map((capability) => ({ ...capability, checksum: capabilityChecksum(capability) }));
  const documentManifest = documents.slice().sort((a, b) => a.key.localeCompare(b.key)).map((document) => `d|${document.key}|${document.checksum}|${document.enabled}`).join('\n');
  const capabilityManifest = capabilities.slice().sort((a, b) => a.key.localeCompare(b.key)).map((capability) => `c|${capability.key}|${capability.checksum}|${capability.enabled}`).join('\n');
  return {
    release: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 1, checksum: sha256(`${documentManifest}\n${capabilityManifest}`), documents, capabilities },
    profile: { soulText: '', hotUserText: '', hotMemoryText: '', revision: '1', knowledgeRevision: '0', runtimeHash: null },
    knowledge: [{ id: 'fact', subjectKind: 'self', subjectLabel: null, category: 'preference', fact: privateFact, confidence: 0.9, learnedAt: '2026-08-22T00:00:00.000Z' }],
    privateSkills: [], previousHunts: [], conversationHistory: [{ role: 'user', content: 'hello' }],
  };
}

function candidate(): ProductCandidate {
  return {
    candidate_id: 'candidate-1',
    vertical: 'retail',
    item_name: 'Everyday shoe',
    merchant_name: 'Example Merchant',
    canonical_url: 'https://merchant.example/items/1',
    variant_or_size: '10',
    current_price: 79,
    currency: 'USD',
    price_qualifier: null,
    availability: 'In stock',
    fulfillment_or_store_context: 'Pickup available',
    source_url: 'https://merchant.example/items/1/source',
    observed_at: '2026-08-23T00:00:00.000Z',
    verification_status: 'verified',
    image_url: null,
    matched_constraints: ['size 10'],
    tradeoffs: [],
    personalization_reasons: ['Matches a private preference without exposing it'],
  };
}

describe('Claw compiler and isolation boundary', () => {
  it('compiles deterministically and rejects manifest tampering', () => {
    const first = compileClawTurn(bundle());
    expect(compileClawTurn(bundle())).toEqual(first);
    const tampered = bundle();
    tampered.release.documents[0]!.content = 'tampered';
    expect(() => compileClawTurn(tampered)).toThrow('checksum mismatch');
  });

  it('requires private skills to be checksummed and valid Hermes skill documents', () => {
    const valid = bundle();
    const content = '---\nname: private.gifts\ndescription: User-scoped gift preferences.\n---\n# Gift preferences\n';
    valid.privateSkills = [{ key: 'private.gifts', title: 'Gift preferences', content, checksum: sha256(content) }];
    expect(() => compileClawTurn(valid)).not.toThrow();
    valid.privateSkills[0]!.content = '# malformed';
    expect(() => compileClawTurn(valid)).toThrow('checksum mismatch');

    const wrongName = bundle();
    const wrongContent = '---\nname: private.other\ndescription: Wrong namespace.\n---\n';
    wrongName.privateSkills = [{ key: 'private.gifts', title: 'Gift preferences', content: wrongContent, checksum: sha256(wrongContent) }];
    expect(() => compileClawTurn(wrongName)).toThrow('same frontmatter name');
  });

  it('keeps all ten fixture identities pairwise isolated', () => {
    const users = Array.from({ length: 10 }, (_, index) => `${String(index + 1).padStart(8, '0')}-1111-4111-8111-${String(index + 1).padStart(12, '0')}`);
    const identities = users.map((userId) => profileIdentity(userId, 's'.repeat(32)));
    expect(new Set(identities.map((identity) => identity.profileName)).size).toBe(10);
    expect(new Set(identities.map((identity) => identity.sessionId)).size).toBe(10);
    const compiled: CompiledClawTurn[] = users.map((_, index) => compileClawTurn(bundle(`secret-${index}`)));
    for (let owner = 0; owner < compiled.length; owner += 1) {
      for (let other = 0; other < compiled.length; other += 1) {
        expect(compiled[owner]!.instructions.includes(`secret-${other}`)).toBe(owner === other);
      }
    }
  });

  it('keeps whole recent messages inside the configured character budget', () => {
    const rows = [
      { role: 'assistant' as const, content: 'newest' },
      { role: 'user' as const, content: 'middle' },
      { role: 'assistant' as const, content: 'older-long' },
    ];
    expect(boundRecentMessages(rows, 12)).toEqual([
      { role: 'user', content: 'middle' }, { role: 'assistant', content: 'newest' },
    ]);
  });

  it('binds bridge credentials to opaque profiles', () => {
    const secret = 's'.repeat(32);
    const profile = 'apt-0123456789abcdef0123';
    const token = aptBridgeToken(profile, secret);
    expect(verifyAptBridgeToken(token, secret)).toBe(profile);
    expect(verifyAptBridgeToken(token, 'x'.repeat(32))).toBeNull();
  });

  it('blocks private and metadata-network address ranges', () => {
    for (const address of [
      '127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254',
      '100.64.0.1', '198.18.0.1', '::1', 'fe80::1', 'fe90::1', 'fd00::1', '::ffff:127.0.0.1',
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('requires HTTPS for the configured commerce provider', async () => {
    const adapter = new HttpCommerceSearchAdapter('http://example.com/search', 'secret');
    await expect(adapter.search({
      vertical: 'retail', goal: 'shoes', constraints: {}, location_required: false, result_limit: 5, query_hints: [],
    }, null, new AbortController().signal)).rejects.toThrow('must use HTTPS');
  });
});

describe('Claw service tool binding', () => {
  it('does not let tool arguments select another user and degrades location safely', async () => {
    const calls: string[] = [];
    const repository = fakeRepository(calls);
    const commerce = { search: vi.fn(async () => []) };
    const service = new ClawService(repository, commerce);
    const context = {
      userId: '11111111-1111-4111-8111-111111111111',
      runId: '33333333-3333-4333-8333-333333333333',
      requestMessageId: '44444444-4444-4444-8444-444444444444',
      location: null as ForegroundLocation | null,
    };
    await expect(service.invoke(context, 'apt_search_knowledge', { query: 'shoe', limit: 5, userId: 'attacker' })).rejects.toThrow();
    expect(calls).toEqual([]);
    await expect(service.invoke(context, 'apt_commerce_hunt', {
      vertical: 'retail', goal: 'nearby shoes', constraints: {}, location_required: true, result_limit: 5, query_hints: [],
    })).resolves.toEqual({ status: 'LOCATION_REQUIRED', candidates: [] });
    expect(commerce.search).not.toHaveBeenCalled();
  });

  it('cancels an in-flight Hunt when its run is stopped', async () => {
    const statuses: string[] = [];
    const repository = fakeRepository([]);
    repository.saveHunt = async (input) => { statuses.push(input.status); };
    const commerce = {
      search: vi.fn(async (_input, _location, signal: AbortSignal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })),
    };
    const service = new ClawService(repository, commerce);
    const context = {
      userId: '11111111-1111-4111-8111-111111111111',
      runId: '33333333-3333-4333-8333-333333333333',
      requestMessageId: '44444444-4444-4444-8444-444444444444',
      location: null,
    };
    const hunt = service.invoke(context, 'apt_commerce_hunt', {
      vertical: 'retail', goal: 'running shoes', constraints: {}, location_required: false, result_limit: 5, query_hints: [],
    });
    service.cancelRun(context.runId);
    await expect(hunt).rejects.toThrow('aborted');
    expect(statuses).toEqual(['cancelled']);
  });

  it('passes point-of-need location only to commerce retrieval and never Hunt persistence', async () => {
    const saved: unknown[] = [];
    const repository = fakeRepository([]);
    repository.saveHunt = async (input) => { saved.push(input); };
    const commerce = { search: vi.fn(async () => [candidate()]) };
    const service = new ClawService(repository, commerce);
    const location = {
      latitude: 40.7,
      longitude: -74,
      accuracy: 25,
      capturedAt: '2026-08-23T00:00:00.000Z',
    };
    const context = {
      userId: '11111111-1111-4111-8111-111111111111',
      runId: '33333333-3333-4333-8333-333333333333',
      requestMessageId: '44444444-4444-4444-8444-444444444444',
      location,
    };

    await expect(service.invoke(context, 'apt_commerce_hunt', {
      vertical: 'retail', goal: 'nearby shoes', constraints: { size: '10' },
      location_required: true, result_limit: 5, query_hints: ['walking shoes'],
    })).resolves.toEqual({ status: 'COMPLETED', candidates: [candidate()] });
    expect(commerce.search).toHaveBeenCalledWith(expect.objectContaining({ vertical: 'retail' }), location, expect.any(AbortSignal));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      category: 'retail',
      query: { vertical: 'retail', goal: 'nearby shoes', query_hints: ['walking shoes'] },
      constraints: { size: '10' },
      sourceUrls: ['https://merchant.example/items/1/source', 'https://merchant.example/items/1'],
      status: 'completed',
    });
    expect(JSON.stringify(saved[0])).not.toContain(String(location.latitude));
    expect(JSON.stringify(saved[0])).not.toContain(String(location.longitude));
  });
});

function fakeRepository(calls: string[]): ClawRepository {
  return {
    async loadTurn() { return bundle(); }, async pinRun() {}, async setRuntimeHash() {},
    async searchKnowledge(userId) { calls.push(userId); return []; },
    async remember() { return bundle().knowledge[0]!; }, async updatePrivateArtifact() { return bundle().profile; },
    async createProposal() { return { id: 'proposal', status: 'pending' }; }, async previousHunts() { return []; },
    async saveHunt() {}, async reconcileRuntimeArtifacts() {}, async close() {},
  };
}
