import { z } from 'zod';
import { AppError } from '../errors.js';
import { assertPublicHttpUrl } from '../claw/commerce.js';
import { productCandidateSchema } from '../claw/domain.js';
import {
  normalizeBoardTitle,
  normalizeProductUrl,
  productReferenceSchema,
  shoppingItemKey,
  SHOPPING_LIMITS,
  type ProductReference,
  type ResolvedProductReference,
  type ShoppingListKind,
  type TrustedItemSnapshot,
} from './domain.js';
import type { ShoppingBoardPatch, ShoppingRepository } from './repository.js';

const createBoardSchema = z.object({
  title: z.string().max(SHOPPING_LIMITS.boardTitle + 20),
  description: z.string().max(SHOPPING_LIMITS.boardDescription).nullable().optional(),
  contextSummary: z.string().max(SHOPPING_LIMITS.boardContextSummary).optional(),
}).strict();

const updateBoardSchema = z.object({
  title: z.string().max(SHOPPING_LIMITS.boardTitle + 20).optional(),
  description: z.string().max(SHOPPING_LIMITS.boardDescription).nullable().optional(),
  contextSummary: z.string().max(SHOPPING_LIMITS.boardContextSummary).optional(),
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
}).strict().refine(
  (value) => value.title !== undefined || value.description !== undefined || value.contextSummary !== undefined,
  { message: 'At least one Board field must be updated.' },
);

export type ShoppingActor = 'mobile' | 'claw';

export class ShoppingService {
  constructor(private readonly repository: ShoppingRepository) {}

  getSummary(userId: string) {
    return this.repository.getSummary(userId);
  }

  getCart(userId: string) {
    return this.repository.getList(userId, 'cart');
  }

  getWishlist(userId: string) {
    return this.repository.getList(userId, 'wishlist');
  }

  listBoards(userId: string) {
    return this.repository.listBoards(userId);
  }

  getBoard(userId: string, boardId: string) {
    return this.repository.getBoard(userId, boardId);
  }

  async addToCart(userId: string, rawReference: unknown, actor: ShoppingActor) {
    const reference = await this.resolveReference(userId, rawReference, actor);
    return this.repository.setListMembership(userId, reference, 'cart');
  }

  async addToWishlist(userId: string, rawReference: unknown, actor: ShoppingActor) {
    const reference = await this.resolveReference(userId, rawReference, actor);
    return this.repository.setListMembership(userId, reference, 'wishlist');
  }

  setCartQuantity(userId: string, itemId: string, rawQuantity: unknown) {
    const quantity = z.number().int().min(1).max(99).safeParse(rawQuantity);
    if (!quantity.success) throw new AppError('INVALID_QUANTITY', 'Cart quantity must be an integer from 1 to 99.');
    return this.repository.setCartQuantity(userId, itemId, quantity.data);
  }

  removeFromCart(userId: string, itemId: string) {
    return this.repository.removeListMembership(userId, itemId, 'cart');
  }

  removeFromWishlist(userId: string, itemId: string) {
    return this.repository.removeListMembership(userId, itemId, 'wishlist');
  }

  async createBoard(userId: string, rawInput: unknown, actor: ShoppingActor) {
    const parsed = createBoardSchema.safeParse(rawInput);
    if (!parsed.success) throw new AppError('INVALID_MESSAGE', 'Board details are invalid.');
    const title = normalizeBoardTitle(parsed.data.title);
    if (!title || title.length > SHOPPING_LIMITS.boardTitle) {
      throw new AppError('INVALID_MESSAGE', 'Board title must contain 1 to 80 characters.');
    }
    const description = parsed.data.description?.trim() || null;
    const contextSummary = actor === 'claw' ? parsed.data.contextSummary?.trim() ?? '' : '';
    return this.repository.createBoard(userId, title, description, contextSummary);
  }

  async updateBoard(userId: string, boardId: string, rawInput: unknown) {
    const parsed = updateBoardSchema.safeParse(rawInput);
    if (!parsed.success) throw new AppError('INVALID_MESSAGE', 'Board update is invalid.');
    const patch: ShoppingBoardPatch = { expectedUpdatedAt: parsed.data.expectedUpdatedAt };
    if (parsed.data.title !== undefined) {
      const title = normalizeBoardTitle(parsed.data.title);
      if (!title || title.length > SHOPPING_LIMITS.boardTitle) {
        throw new AppError('INVALID_MESSAGE', 'Board title must contain 1 to 80 characters.');
      }
      patch.title = title;
    }
    if (parsed.data.description !== undefined) patch.description = parsed.data.description?.trim() || null;
    if (parsed.data.contextSummary !== undefined) patch.contextSummary = parsed.data.contextSummary.trim();
    return this.repository.updateBoard(userId, boardId, patch);
  }

  deleteBoard(userId: string, boardId: string) {
    return this.repository.deleteBoard(userId, boardId);
  }

  async addToBoard(userId: string, boardId: string, rawReference: unknown, actor: ShoppingActor) {
    const reference = await this.resolveReference(userId, rawReference, actor);
    return this.repository.addBoardItem(userId, boardId, reference);
  }

  removeFromBoard(userId: string, boardId: string, itemId: string) {
    return this.repository.removeBoardItem(userId, boardId, itemId);
  }

  async resolveReference(
    userId: string,
    rawReference: unknown,
    actor: ShoppingActor,
  ): Promise<ResolvedProductReference> {
    const parsed = productReferenceSchema.safeParse(rawReference);
    if (!parsed.success) throw new AppError('INVALID_PRODUCT_SOURCE', 'Product source is invalid.');
    const reference = parsed.data;
    if (reference.kind === 'existing_item') return reference;
    if (reference.kind === 'feed_fixture') {
      if (actor !== 'mobile') {
        throw new AppError('INVALID_PRODUCT_SOURCE', 'Feed fixtures are accepted only from authenticated mobile routes.');
      }
      const snapshot = await this.validateSnapshot(reference.snapshot);
      return resolvedSnapshot(reference, snapshot);
    }
    const rawCandidate = await this.repository.findHuntCandidate(userId, reference.huntId, reference.candidateId);
    if (!rawCandidate) throw new AppError('PRODUCT_SOURCE_NOT_FOUND', 'Owned Hunt candidate not found.');
    const candidate = productCandidateSchema.safeParse(rawCandidate);
    if (!candidate.success || candidate.data.candidate_id !== reference.candidateId) {
      throw new AppError('INVALID_PRODUCT_SOURCE', 'Stored Hunt candidate is invalid.');
    }
    const { candidate_id: _candidateId, ...candidateSnapshot } = candidate.data;
    const snapshot = await this.validateSnapshot(candidateSnapshot);
    return resolvedSnapshot(reference, snapshot);
  }

  private async validateSnapshot(snapshot: TrustedItemSnapshot): Promise<TrustedItemSnapshot> {
    try {
      await Promise.all([
        assertPublicHttpUrl(snapshot.canonical_url),
        assertPublicHttpUrl(snapshot.source_url),
        ...(snapshot.image_url ? [assertPublicHttpUrl(snapshot.image_url)] : []),
      ]);
      return { ...snapshot, canonical_url: normalizeProductUrl(snapshot.canonical_url) };
    } catch (error) {
      throw new AppError('UNSAFE_PRODUCT_URL', 'Product source URL is not a safe public HTTP(S) destination.', { cause: error });
    }
  }
}

function resolvedSnapshot(
  reference: Exclude<ProductReference, { kind: 'existing_item' }>,
  snapshot: TrustedItemSnapshot,
): ResolvedProductReference {
  return {
    kind: 'snapshot',
    value: {
      sourceKind: reference.kind,
      sourceHuntId: reference.kind === 'hunt_candidate' ? reference.huntId : null,
      sourceCandidateId: reference.kind === 'hunt_candidate' ? reference.candidateId : null,
      feedFixtureId: reference.kind === 'feed_fixture' ? reference.fixtureId : null,
      itemKey: shoppingItemKey(snapshot.candidate_kind, snapshot.canonical_url, snapshot.variant_or_size),
      snapshot,
    },
  };
}

export function listKindFromScope(scope: 'cart' | 'wishlist'): ShoppingListKind {
  return scope;
}
