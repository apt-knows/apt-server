import { Pool } from 'pg';
import { loadConfig } from '../src/config.js';
import { PostgresShoppingRepository } from '../src/shopping/repository.js';
import { ShoppingService } from '../src/shopping/service.js';

const config = loadConfig();
const poolOptions = {
  connectionString: config.supabase.databaseUrl,
  ssl: config.supabase.databaseSsl ? { rejectUnauthorized: false } : undefined,
};
const pool = new Pool({ ...poolOptions, max: 1 });
const repository = PostgresShoppingRepository.create(config.supabase.databaseUrl, config.supabase.databaseSsl);
const shopping = new ShoppingService(repository);
const runKey = `apt9-live-${Date.now()}`;
const boardPrefix = `APT9 live ${Date.now()}`;

try {
  const users = await pool.query<{ id: string }>(
    'select id from auth.users order by created_at, id limit 2',
  );
  const userA = users.rows[0]?.id;
  const userB = users.rows[1]?.id;
  if (!userA || !userB) throw new Error('The live Shopping suite requires two Auth users.');

  const first = await shopping.addToCart(userA, feedReference(`${runKey}-item`, 'product'), 'mobile');
  const itemId = first.item.id;
  if (!first.changed || first.movedFrom !== null || first.item.listKind !== 'cart') {
    throw new Error('Initial Cart mutation did not report truthful state.');
  }
  const duplicate = await shopping.addToCart(userA, feedReference(`${runKey}-item`, 'product'), 'mobile');
  if (duplicate.changed || duplicate.item.id !== itemId) throw new Error('Duplicate Cart add was not idempotent.');

  await shopping.setCartQuantity(userA, itemId, 3);
  const boardOne = await shopping.createBoard(userA, { title: `${boardPrefix} One` }, 'mobile');
  const boardDuplicate = await shopping.createBoard(userA, { title: `  ${boardPrefix.toUpperCase()}   ONE ` }, 'mobile');
  if (!boardOne.changed || boardDuplicate.changed || boardOne.board.id !== boardDuplicate.board.id) {
    throw new Error('Case-insensitive Board creation was not idempotent.');
  }
  const boardTwo = await shopping.createBoard(userA, { title: `${boardPrefix} Two` }, 'mobile');
  await shopping.addToBoard(userA, boardOne.board.id, existingReference(itemId), 'mobile');
  await shopping.addToBoard(userA, boardTwo.board.id, existingReference(itemId), 'mobile');

  const moved = await shopping.addToWishlist(userA, existingReference(itemId), 'mobile');
  if (!moved.changed || moved.movedFrom !== 'cart' || moved.item.listKind !== 'wishlist' || moved.item.quantity !== 1) {
    throw new Error('Cart-to-Wishlist move semantics failed.');
  }
  if (moved.item.boardIds.length !== 2) throw new Error('List move removed independent Board memberships.');

  await shopping.deleteBoard(userA, boardOne.board.id);
  const afterDelete = await repository.getItem(userA, itemId);
  if (afterDelete.listKind !== 'wishlist' || afterDelete.boardIds.length !== 1 || afterDelete.boardIds[0] !== boardTwo.board.id) {
    throw new Error('Board deletion changed unrelated Shopping state.');
  }

  const place = await shopping.addToWishlist(userA, feedReference(`${runKey}-place`, 'merchant_or_place'), 'mobile');
  await expectCode(
    () => shopping.addToCart(userA, existingReference(place.item.id), 'mobile'),
    'ITEM_NOT_CART_ELIGIBLE',
  );
  await expectCode(
    () => shopping.addToWishlist(userB, existingReference(itemId), 'mobile'),
    'SHOPPING_ITEM_NOT_FOUND',
  );

  const userBMutation = await shopping.addToWishlist(userB, feedReference(`${runKey}-user-b`, 'product'), 'mobile');
  if (userBMutation.item.id === itemId || userBMutation.item.boardIds.length !== 0) {
    throw new Error('Second-user Shopping state was not isolated.');
  }

  const [cartA, wishlistA, wishlistB] = await Promise.all([
    shopping.getCart(userA), shopping.getWishlist(userA), shopping.getWishlist(userB),
  ]);
  if (cartA.some((entry) => entry.id === itemId) || !wishlistA.some((entry) => entry.id === itemId) ||
      wishlistB.some((entry) => entry.id === itemId)) {
    throw new Error('Canonical list reads did not preserve user isolation.');
  }

  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    checks: [
      'duplicate-add-idempotency', 'absolute-quantity', 'cart-wishlist-exclusivity',
      'multi-board-membership', 'board-delete-independence', 'cart-eligibility', 'two-user-isolation',
    ],
  })}\n`);
} finally {
  await pool.query('delete from public.shopping_boards where title like $1', [`${boardPrefix}%`]);
  await pool.query('delete from public.shopping_items where feed_fixture_id like $1', [`${runKey}%`]);
  await Promise.allSettled([repository.close(), pool.end()]);
}

function existingReference(shoppingItemId: string) {
  return { kind: 'existing_item' as const, shoppingItemId };
}

function feedReference(fixtureId: string, candidateKind: 'product' | 'merchant_or_place') {
  return {
    kind: 'feed_fixture' as const,
    fixtureId,
    snapshot: {
      vertical: 'retail' as const,
      candidate_kind: candidateKind,
      item_name: candidateKind === 'product' ? 'APT-9 live product' : 'APT-9 live merchant',
      merchant_name: 'Example Merchant',
      canonical_url: `https://example.com/${fixtureId}`,
      variant_or_size: candidateKind === 'product' ? 'M' : null,
      current_price: candidateKind === 'product' ? 20 : null,
      currency: candidateKind === 'product' ? 'USD' : null,
      price_qualifier: null,
      availability: null,
      fulfillment_or_store_context: null,
      source_url: `https://example.com/${fixtureId}`,
      observed_at: new Date().toISOString(),
      verification_status: 'unconfirmed' as const,
      image_url: null,
      matched_constraints: [],
      tradeoffs: [],
      personalization_reasons: [],
    },
  };
}

async function expectCode(operation: () => Promise<unknown>, code: string) {
  try {
    await operation();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === code) return;
    throw error;
  }
  throw new Error(`Expected ${code}.`);
}
