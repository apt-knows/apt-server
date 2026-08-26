import { beforeEach, describe, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));

import type { ShoppingRepository } from '../src/shopping/repository.js';
import { ShoppingService } from '../src/shopping/service.js';
import { USER_A } from './fixtures.js';

const HUNT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ITEM_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    candidate_id: 'candidate-2',
    vertical: 'retail',
    candidate_kind: 'product',
    item_name: 'Everyday shoe',
    merchant_name: 'Example Merchant',
    canonical_url: 'https://shop.example/items/1?utm_source=hunt#details',
    variant_or_size: 'Blue / M',
    current_price: 79,
    currency: 'USD',
    price_qualifier: null,
    availability: 'In stock',
    fulfillment_or_store_context: 'Pickup available',
    source_url: 'https://shop.example/items/1/source',
    observed_at: '2026-08-25T20:00:00.000Z',
    verification_status: 'verified',
    image_url: null,
    matched_constraints: [],
    tradeoffs: [],
    personalization_reasons: [],
    ...overrides,
  };
}

function repository(overrides: Partial<ShoppingRepository> = {}) {
  return {
    findHuntCandidate: vi.fn(async () => candidate()),
    getSummary: vi.fn(), getItem: vi.fn(), getList: vi.fn(),
    setListMembership: vi.fn(async (_userId, reference) => ({
      item: { id: reference.kind === 'existing_item' ? reference.shoppingItemId : ITEM_ID },
      changed: true, movedFrom: null,
    })),
    setCartQuantity: vi.fn(), removeListMembership: vi.fn(), listBoards: vi.fn(), getBoard: vi.fn(),
    createBoard: vi.fn(), updateBoard: vi.fn(), deleteBoard: vi.fn(),
    addBoardItem: vi.fn(), removeBoardItem: vi.fn(), close: vi.fn(),
    ...overrides,
  } as unknown as ShoppingRepository;
}

describe('ShoppingService trusted-reference boundary', () => {
  beforeEach(() => {
    network.lookup.mockReset();
    network.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
  });

  it('resolves only the authenticated user\'s stored Hunt candidate and promotes a normalized snapshot', async () => {
    const repo = repository();
    const service = new ShoppingService(repo);
    await service.addToCart(USER_A, { kind: 'hunt_candidate', huntId: HUNT_ID, candidateId: 'candidate-2' }, 'claw');
    expect(repo.findHuntCandidate).toHaveBeenCalledWith(USER_A, HUNT_ID, 'candidate-2');
    expect(repo.setListMembership).toHaveBeenCalledWith(USER_A, expect.objectContaining({
      kind: 'snapshot',
      value: expect.objectContaining({
        sourceKind: 'hunt_candidate',
        sourceHuntId: HUNT_ID,
        sourceCandidateId: 'candidate-2',
        itemKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        snapshot: expect.objectContaining({ canonical_url: 'https://shop.example/items/1' }),
      }),
    }), 'cart');
  });

  it('rejects foreign/missing candidates, raw model metadata, and Claw Feed fixtures', async () => {
    const missing = repository({ findHuntCandidate: vi.fn(async () => null) });
    await expect(new ShoppingService(missing).addToWishlist(USER_A, {
      kind: 'hunt_candidate', huntId: HUNT_ID, candidateId: 'candidate-2',
    }, 'claw')).rejects.toEqual(expect.objectContaining({ code: 'PRODUCT_SOURCE_NOT_FOUND' }));

    const repo = repository();
    const service = new ShoppingService(repo);
    await expect(service.addToCart(USER_A, {
      kind: 'hunt_candidate', huntId: HUNT_ID, candidateId: 'candidate-2', current_price: 1,
    }, 'claw')).rejects.toEqual(expect.objectContaining({ code: 'INVALID_PRODUCT_SOURCE' }));
    await expect(service.addToWishlist(USER_A, {
      kind: 'feed_fixture', fixtureId: 'feed-1', snapshot: { ...candidate(), candidate_id: undefined, verification_status: 'unconfirmed' },
    }, 'claw')).rejects.toEqual(expect.objectContaining({ code: 'INVALID_PRODUCT_SOURCE' }));
    expect(repo.setListMembership).not.toHaveBeenCalled();
  });

  it('fails closed when a stored candidate URL resolves to a private network', async () => {
    network.lookup.mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
    const repo = repository();
    await expect(new ShoppingService(repo).addToCart(USER_A, {
      kind: 'hunt_candidate', huntId: HUNT_ID, candidateId: 'candidate-2',
    }, 'mobile')).rejects.toEqual(expect.objectContaining({ code: 'UNSAFE_PRODUCT_URL' }));
    expect(repo.setListMembership).not.toHaveBeenCalled();
  });

  it('keeps public Board creation brief-free and validates absolute Cart quantity', async () => {
    const createBoard = vi.fn(async () => ({
      board: {
        id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', title: 'Ski Trip', description: 'Winter gear',
        contextSummary: '', itemCount: 0, thumbnails: [], items: [],
        createdAt: '2026-08-25T20:00:00.000Z', updatedAt: '2026-08-25T20:00:00.000Z',
      },
      changed: true,
    }));
    const setCartQuantity = vi.fn();
    const repo = repository({ createBoard, setCartQuantity });
    const service = new ShoppingService(repo);
    await service.createBoard(USER_A, {
      title: '  Ski   Trip  ', description: '  Winter gear  ', contextSummary: 'model-authored',
    }, 'mobile');
    expect(createBoard).toHaveBeenCalledWith(USER_A, 'Ski Trip', 'Winter gear', '');
    expect(() => service.setCartQuantity(USER_A, ITEM_ID, 0)).toThrow(expect.objectContaining({ code: 'INVALID_QUANTITY' }));
    expect(setCartQuantity).not.toHaveBeenCalled();
  });
});
