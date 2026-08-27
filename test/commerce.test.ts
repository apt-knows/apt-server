import { beforeEach, describe, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));

import { assertPublicHttpUrl, validateBrowserHuntRecord } from '../src/claw/commerce.js';
import type { CommerceHuntRecord, ProductCandidate } from '../src/claw/domain.js';

function candidate(overrides: Partial<ProductCandidate> = {}): ProductCandidate {
  return {
    candidate_id: 'candidate-1',
    vertical: 'retail',
    candidate_kind: 'product',
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
    observed_at: new Date().toISOString(),
    verification_status: 'verified',
    image_url: null,
    matched_constraints: ['size 10'],
    tradeoffs: [],
    personalization_reasons: ['Matches stated preferences'],
    ...overrides,
  };
}

function record(overrides: Partial<CommerceHuntRecord> = {}): CommerceHuntRecord {
  return {
    vertical: 'retail',
    goal: 'nearby walking shoes',
    constraints: { size: '10' },
    location_required: true,
    result_limit: 1,
    query_hints: ['comfortable'],
    candidates: [candidate()],
    ...overrides,
  };
}

describe('browser-researched Hunt evidence boundary', () => {
  beforeEach(() => {
    network.lookup.mockReset();
    network.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });

  it('validates typed current evidence and public source URLs without retrieving commerce data', async () => {
    const input = record();
    await expect(validateBrowserHuntRecord(input)).resolves.toEqual(input);
    expect(network.lookup).toHaveBeenCalledTimes(2);
    expect(network.lookup).toHaveBeenCalledWith('merchant.example', { all: true, verbatim: true });
  });

  it('rejects mismatched verticals, duplicate IDs, and candidates above the requested limit', async () => {
    const duplicate = candidate({ vertical: 'food' });
    await expect(validateBrowserHuntRecord(record({
      result_limit: 1,
      candidates: [candidate(), duplicate],
    }))).rejects.toThrow();
    expect(network.lookup).not.toHaveBeenCalled();
  });

  it('rejects stale observations and credential-bearing or private URLs', async () => {
    await expect(validateBrowserHuntRecord(record({
      candidates: [candidate({ observed_at: '2026-08-20T00:00:00.000Z' })],
    }), Date.parse('2026-08-23T00:00:00.000Z'))).rejects.toThrow('within the last 24 hours');

    await expect(assertPublicHttpUrl('https://user:secret@merchant.example/item')).rejects.toThrow('credential-free');
    network.lookup.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
    await expect(assertPublicHttpUrl('https://merchant.example/item')).rejects.toThrow('metadata-network URLs are blocked');
  });

  it('rejects merchant homepages and duplicate product URLs as product evidence', async () => {
    await expect(validateBrowserHuntRecord(record({
      candidates: [candidate({ canonical_url: 'https://merchant.example/', source_url: 'https://merchant.example/' })],
    }))).rejects.toThrow('direct-product URL');

    await expect(validateBrowserHuntRecord(record({
      result_limit: 2,
      candidates: [candidate(), candidate({ candidate_id: 'candidate-2' })],
    }))).rejects.toThrow('distinct direct-product URL');
    expect(network.lookup).not.toHaveBeenCalled();
  });

  it('requires affirmative coarse-area and fulfillment evidence for location-scoped candidates', async () => {
    const grocery = candidate({
      vertical: 'grocery',
      candidate_kind: 'grocery_item',
      fulfillment_or_store_context: 'Pickup at LIC Court Square serving 11101',
    });
    const input = record({
      vertical: 'grocery',
      constraints: { location: 'New York, NY, 11101, US', fulfillment: 'pickup' },
      candidates: [grocery],
    });
    const requirements = { locationRequired: true, coarseLocationLabel: 'New York, NY, 11101, US' };

    await expect(validateBrowserHuntRecord(input, Date.now(), requirements)).resolves.toEqual(input);
    await expect(validateBrowserHuntRecord(record({
      ...input,
      candidates: [candidate({
        vertical: 'grocery',
        candidate_kind: 'grocery_item',
        fulfillment_or_store_context: 'Pickup at 672 Memorial Drive, Chicopee, MA 01020; not near 11101',
      })],
    }), Date.now(), requirements)).rejects.toThrow('does not verify the coarse search area');
    await expect(validateBrowserHuntRecord(record({
      ...input,
      candidates: [candidate({
        vertical: 'grocery',
        candidate_kind: 'grocery_item',
        fulfillment_or_store_context: 'Ships to 11101',
      })],
    }), Date.now(), requirements)).rejects.toThrow('requested fulfillment method');
    await expect(validateBrowserHuntRecord(record({
      ...input,
      candidates: [candidate({
        vertical: 'grocery',
        candidate_kind: 'grocery_item',
        fulfillment_or_store_context: 'Pickup unavailable at 11101',
      })],
    }), Date.now(), requirements)).rejects.toThrow('requested fulfillment method');
  });

  it('blocks local schemes and hostnames before DNS resolution', async () => {
    await expect(assertPublicHttpUrl('file:///etc/passwd')).rejects.toThrow('public HTTP(S)');
    await expect(assertPublicHttpUrl('http://localhost:8787/internal')).rejects.toThrow('Local network URLs are blocked');
    expect(network.lookup).not.toHaveBeenCalled();
  });
});
