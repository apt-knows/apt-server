import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { AppError } from '../src/errors.js';
import type { ShoppingItem, ShoppingListEntry } from '../src/shopping/domain.js';
import type { ShoppingRepository } from '../src/shopping/repository.js';
import { ShoppingService } from '../src/shopping/service.js';
import { auth, config, repository as chatRepository, runtime, USER_A, USER_B } from './fixtures.js';

const ITEM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOARD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

function item(overrides: Partial<ShoppingItem> = {}): ShoppingItem {
  return {
    id: ITEM_ID, sourceKind: 'feed_fixture', sourceHuntId: null, sourceCandidateId: null,
    feedFixtureId: 'feed-1', vertical: 'retail', candidateKind: 'product', cartEligible: true,
    itemName: 'Jacket', merchantName: 'Example', canonicalUrl: 'https://shop.example/jacket',
    sourceUrl: 'https://shop.example/jacket', variantOrSize: 'M', imageUrl: null,
    currentPrice: 100, currency: 'USD', priceQualifier: null, availability: 'In stock',
    fulfillmentOrStoreContext: null, verificationStatus: 'unconfirmed',
    observedAt: '2026-08-25T20:00:00.000Z', matchedConstraints: [], tradeoffs: [],
    personalizationReasons: [], listKind: null, quantity: null, boardIds: [],
    createdAt: '2026-08-25T20:00:00.000Z', updatedAt: '2026-08-25T20:00:00.000Z',
    ...overrides,
  };
}

function listItem(kind: 'cart' | 'wishlist' = 'cart'): ShoppingListEntry {
  return {
    ...item({ listKind: kind, quantity: 1 }), listKind: kind, quantity: 1,
    membershipCreatedAt: '2026-08-25T20:00:00.000Z', membershipUpdatedAt: '2026-08-25T20:00:00.000Z',
  };
}

function shoppingRepository(overrides: Partial<ShoppingRepository> = {}): ShoppingRepository {
  return {
    findHuntCandidate: vi.fn(),
    getSummary: vi.fn(async () => ({
      cartTotalQuantity: 1, wishlistItemCount: 0, boardCount: 0,
      subtotals: [{ currency: 'USD', amount: 100 }], unavailablePriceCount: 0,
    })),
    getItem: vi.fn(async () => item()), getList: vi.fn(async () => [listItem()]),
    setListMembership: vi.fn(async () => ({ item: listItem(), changed: true, movedFrom: 'wishlist' as const })),
    setCartQuantity: vi.fn(async () => ({ item: listItem(), changed: true, movedFrom: null })),
    removeListMembership: vi.fn(async () => ({ item: item(), changed: true, movedFrom: null })),
    listBoards: vi.fn(async () => []),
    getBoard: vi.fn(async () => ({
      id: BOARD_ID, title: 'Ski Trip', description: null, contextSummary: '', itemCount: 0,
      thumbnails: [], items: [], createdAt: '2026-08-25T20:00:00.000Z', updatedAt: '2026-08-25T20:00:00.000Z',
    })),
    createBoard: vi.fn(), updateBoard: vi.fn(), deleteBoard: vi.fn(), addBoardItem: vi.fn(), removeBoardItem: vi.fn(),
    close: vi.fn(async () => undefined), ...overrides,
  };
}

async function appWithShopping(overrides: Partial<ShoppingRepository> = {}) {
  const shoppingRepo = shoppingRepository(overrides);
  const app = await buildApp({
    config, auth: auth(), repository: chatRepository(), runtime: runtime(),
    shoppingService: new ShoppingService(shoppingRepo),
  });
  apps.push(app);
  await app.ready();
  return { app, shoppingRepo };
}

describe('Shopping API', () => {
  it('requires Supabase authentication on every Shopping route', async () => {
    const { app } = await appWithShopping();
    for (const request of [
      { method: 'GET', url: '/v1/shopping/summary' },
      { method: 'GET', url: '/v1/cart' },
      { method: 'POST', url: '/v1/cart/items', payload: {} },
      { method: 'PATCH', url: `/v1/cart/items/${ITEM_ID}`, payload: {} },
      { method: 'DELETE', url: `/v1/cart/items/${ITEM_ID}` },
      { method: 'GET', url: '/v1/wishlist' },
      { method: 'POST', url: '/v1/wishlist/items', payload: {} },
      { method: 'DELETE', url: `/v1/wishlist/items/${ITEM_ID}` },
      { method: 'GET', url: '/v1/boards' },
      { method: 'POST', url: '/v1/boards', payload: {} },
      { method: 'GET', url: `/v1/boards/${BOARD_ID}` },
      { method: 'PATCH', url: `/v1/boards/${BOARD_ID}`, payload: {} },
      { method: 'DELETE', url: `/v1/boards/${BOARD_ID}` },
      { method: 'POST', url: `/v1/boards/${BOARD_ID}/items`, payload: {} },
      { method: 'DELETE', url: `/v1/boards/${BOARD_ID}/items/${ITEM_ID}` },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('derives ownership from the JWT and returns truthful move semantics', async () => {
    const setListMembership = vi.fn(async () => ({ item: listItem(), changed: true, movedFrom: 'wishlist' as const }));
    const { app } = await appWithShopping({ setListMembership });
    const response = await app.inject({
      method: 'POST', url: '/v1/cart/items', headers: { authorization: 'Bearer token-a' },
      payload: { reference: { kind: 'existing_item', shoppingItemId: ITEM_ID } },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ changed: true, movedFrom: 'wishlist' });
    expect(setListMembership).toHaveBeenCalledWith(USER_A, { kind: 'existing_item', shoppingItemId: ITEM_ID }, 'cart');
  });

  it('returns stable quantity and non-owned-resource errors without leaking another user', async () => {
    const getBoard = vi.fn(async (userId: string) => {
      if (userId === USER_B) throw new AppError('BOARD_NOT_FOUND', 'Board not found.');
      throw new Error('unexpected');
    });
    const { app } = await appWithShopping({ getBoard });
    const quantity = await app.inject({
      method: 'PATCH', url: `/v1/cart/items/${ITEM_ID}`, headers: { authorization: 'Bearer token-a' }, payload: { quantity: 100 },
    });
    expect(quantity.statusCode).toBe(400);
    expect(quantity.json().error.code).toBe('INVALID_QUANTITY');
    const board = await app.inject({
      method: 'GET', url: `/v1/boards/${BOARD_ID}`, headers: { authorization: 'Bearer token-b' },
    });
    expect(board.statusCode).toBe(404);
    expect(board.json()).toEqual({ error: { code: 'BOARD_NOT_FOUND', message: 'Board not found.' } });
  });
});
