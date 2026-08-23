import { beforeEach, describe, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({
  lookup: vi.fn(),
  fetch: vi.fn(),
  agents: [] as Array<{ options: Record<string, unknown>; close: ReturnType<typeof vi.fn> }>,
}));

vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));
vi.mock('undici', () => ({
  Agent: class MockAgent {
    close = vi.fn(async () => undefined);
    constructor(readonly options: Record<string, unknown>) {
      network.agents.push(this);
    }
  },
  fetch: network.fetch,
}));

import { HttpCommerceSearchAdapter } from '../src/claw/commerce.js';
import type { CommerceHuntInput, ForegroundLocation, ProductCandidate } from '../src/claw/domain.js';

const input: CommerceHuntInput = {
  vertical: 'retail',
  goal: 'nearby walking shoes',
  constraints: { size: '10' },
  location_required: true,
  result_limit: 1,
  query_hints: ['comfortable'],
};
const location: ForegroundLocation = {
  latitude: 40.7,
  longitude: -74,
  accuracy: 25,
  capturedAt: '2026-08-23T00:00:00.000Z',
};

function candidate(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
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
    personalization_reasons: ['Matches stated preferences'],
    ...overrides,
  };
}

describe('HTTPS commerce provider boundary', () => {
  beforeEach(() => {
    network.lookup.mockReset();
    network.fetch.mockReset();
    network.agents.length = 0;
    network.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    network.fetch.mockResolvedValue(new Response(JSON.stringify({ candidates: [candidate()] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
  });

  it('pins public DNS, forwards bounded location, and closes the dispatcher', async () => {
    const signal = new AbortController().signal;
    const adapter = new HttpCommerceSearchAdapter('https://provider.example/search', 'provider-secret');
    await expect(adapter.search(input, location, signal)).resolves.toEqual([candidate()]);

    const [url, request] = network.fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://provider.example/search');
    expect(request).toMatchObject({ method: 'POST', redirect: 'manual', signal });
    expect(request.headers).toMatchObject({
      Authorization: 'Bearer provider-secret',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(String(request.body))).toEqual({
      vertical: 'retail',
      goal: 'nearby walking shoes',
      constraints: { size: '10' },
      query_hints: ['comfortable'],
      result_limit: 1,
      location,
    });

    const agent = network.agents[0]!;
    expect(agent.options).toMatchObject({ maxResponseSize: 2 * 1024 * 1024 });
    const callback = vi.fn();
    const connect = agent.options.connect as { lookup: (hostname: string, options: { all: boolean }, callback: (...values: unknown[]) => void) => void };
    connect.lookup('provider.example', { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [{ address: '8.8.8.8', family: 4 }]);
    expect(agent.close).toHaveBeenCalledOnce();
  });

  it('does not forward a coordinate unless the typed Hunt explicitly requires it', async () => {
    const adapter = new HttpCommerceSearchAdapter('https://provider.example/search', 'provider-secret');
    await adapter.search({ ...input, location_required: false }, location, new AbortController().signal);
    expect(JSON.parse(String(network.fetch.mock.calls[0]![1].body))).not.toHaveProperty('location');
  });

  it('rejects redirects and candidates outside the requested vertical', async () => {
    const adapter = new HttpCommerceSearchAdapter('https://provider.example/search', 'provider-secret');
    network.fetch.mockResolvedValueOnce(new Response('', { status: 302, headers: { location: 'https://other.example' } }));
    await expect(adapter.search(input, location, new AbortController().signal)).rejects.toThrow('redirects are not allowed');

    network.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ candidates: [candidate({ vertical: 'food' })] }), { status: 200 }));
    await expect(adapter.search(input, location, new AbortController().signal)).rejects.toThrow('outside the requested vertical');
    expect(network.agents.every((agent) => agent.close.mock.calls.length === 1)).toBe(true);
  });

  it('blocks private endpoint and merchant URL resolution before accepting results', async () => {
    network.lookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const privateEndpoint = new HttpCommerceSearchAdapter('https://provider.example/search', 'provider-secret');
    await expect(privateEndpoint.search(input, location, new AbortController().signal)).rejects.toThrow('metadata-network URLs are blocked');
    expect(network.fetch).not.toHaveBeenCalled();

    network.lookup.mockImplementation(async (hostname: string) => [{
      address: hostname === 'provider.example' ? '8.8.8.8' : '169.254.169.254',
      family: 4,
    }]);
    const privateCandidate = new HttpCommerceSearchAdapter('https://provider.example/search', 'provider-secret');
    await expect(privateCandidate.search(input, location, new AbortController().signal)).rejects.toThrow('metadata-network URLs are blocked');
    expect(network.agents[0]?.close).toHaveBeenCalledOnce();
  });
});
