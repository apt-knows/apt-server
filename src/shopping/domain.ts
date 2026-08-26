import { createHash } from 'node:crypto';
import { z } from 'zod';

export const CANDIDATE_KINDS = [
  'product',
  'grocery_item',
  'menu_item',
  'merchant_or_place',
  'other_find',
] as const;
export const CART_ELIGIBLE_CANDIDATE_KINDS = ['product', 'grocery_item', 'menu_item'] as const;
export const SHOPPING_LIST_KINDS = ['cart', 'wishlist'] as const;
export const SHOPPING_SOURCE_KINDS = ['hunt_candidate', 'feed_fixture'] as const;
export const SHOPPING_VERTICALS = ['retail', 'grocery', 'food'] as const;

export const SHOPPING_LIMITS = {
  boardTitle: 80,
  boardDescription: 1_000,
  boardContextSummary: 2_000,
  boardsPerUser: 50,
  cartEntries: 200,
  wishlistEntries: 200,
  boardItems: 200,
  readDefault: 20,
  readMaximum: 50,
} as const;

export const candidateKindSchema = z.enum(CANDIDATE_KINDS);
export const shoppingListKindSchema = z.enum(SHOPPING_LIST_KINDS);
export const shoppingVerticalSchema = z.enum(SHOPPING_VERTICALS);
export type CandidateKind = z.infer<typeof candidateKindSchema>;
export type ShoppingListKind = z.infer<typeof shoppingListKindSchema>;

const boundedNullable = (maximum: number) => z.string().trim().min(1).max(maximum).nullable();

export const trustedItemSnapshotSchema = z.object({
  vertical: shoppingVerticalSchema,
  candidate_kind: candidateKindSchema,
  item_name: z.string().trim().min(1).max(300),
  merchant_name: z.string().trim().min(1).max(200),
  canonical_url: z.url().max(2_048),
  variant_or_size: boundedNullable(200),
  current_price: z.number().finite().nonnegative().max(99_999_999.99).nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  price_qualifier: boundedNullable(160),
  availability: boundedNullable(200),
  fulfillment_or_store_context: boundedNullable(240),
  source_url: z.url().max(2_048),
  observed_at: z.iso.datetime({ offset: true }),
  verification_status: z.enum(['verified', 'partially_verified', 'unconfirmed']),
  image_url: z.url().max(2_048).nullable(),
  matched_constraints: z.array(z.string().trim().min(1).max(200)).max(20),
  tradeoffs: z.array(z.string().trim().min(1).max(300)).max(10),
  personalization_reasons: z.array(z.string().trim().min(1).max(300)).max(10),
}).strict().superRefine((value, context) => {
  if ((value.current_price === null) !== (value.currency === null)) {
    context.addIssue({
      code: 'custom',
      path: ['currency'],
      message: 'Price and currency must either both be present or both be absent.',
    });
  }
});

export const huntCandidateReferenceSchema = z.object({
  kind: z.literal('hunt_candidate'),
  huntId: z.uuid(),
  candidateId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
}).strict();

export const existingItemReferenceSchema = z.object({
  kind: z.literal('existing_item'),
  shoppingItemId: z.uuid(),
}).strict();

export const feedFixtureReferenceSchema = z.object({
  kind: z.literal('feed_fixture'),
  fixtureId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  snapshot: trustedItemSnapshotSchema.safeExtend({ verification_status: z.literal('unconfirmed') }),
}).strict();

export const productReferenceSchema = z.discriminatedUnion('kind', [
  huntCandidateReferenceSchema,
  existingItemReferenceSchema,
  feedFixtureReferenceSchema,
]);

export type TrustedItemSnapshot = z.infer<typeof trustedItemSnapshotSchema>;
export type ProductReference = z.infer<typeof productReferenceSchema>;

export interface ShoppingItem {
  id: string;
  sourceKind: (typeof SHOPPING_SOURCE_KINDS)[number];
  sourceHuntId: string | null;
  sourceCandidateId: string | null;
  feedFixtureId: string | null;
  vertical: TrustedItemSnapshot['vertical'];
  candidateKind: CandidateKind;
  cartEligible: boolean;
  itemName: string;
  merchantName: string;
  canonicalUrl: string;
  sourceUrl: string;
  variantOrSize: string | null;
  imageUrl: string | null;
  currentPrice: number | null;
  currency: string | null;
  priceQualifier: string | null;
  availability: string | null;
  fulfillmentOrStoreContext: string | null;
  verificationStatus: TrustedItemSnapshot['verification_status'];
  observedAt: string;
  matchedConstraints: string[];
  tradeoffs: string[];
  personalizationReasons: string[];
  listKind: ShoppingListKind | null;
  quantity: number | null;
  boardIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ShoppingListEntry extends ShoppingItem {
  listKind: ShoppingListKind;
  quantity: number;
  membershipCreatedAt: string;
  membershipUpdatedAt: string;
}

export interface ShoppingBoardPreview {
  id: string;
  title: string;
  description: string | null;
  contextSummaryPreview: string;
  itemCount: number;
  thumbnails: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ShoppingBoardDetail extends Omit<ShoppingBoardPreview, 'contextSummaryPreview'> {
  contextSummary: string;
  items: ShoppingItem[];
}

export interface ShoppingSummary {
  cartTotalQuantity: number;
  wishlistItemCount: number;
  boardCount: number;
  subtotals: Array<{ currency: string; amount: number }>;
  unavailablePriceCount: number;
}

export interface ResolvedShoppingSnapshot {
  sourceKind: 'hunt_candidate' | 'feed_fixture';
  sourceHuntId: string | null;
  sourceCandidateId: string | null;
  feedFixtureId: string | null;
  itemKey: string;
  snapshot: TrustedItemSnapshot;
}

export type ResolvedProductReference =
  | { kind: 'existing_item'; shoppingItemId: string }
  | { kind: 'snapshot'; value: ResolvedShoppingSnapshot };

const TRACKING_PARAMETERS = new Set([
  'dclid', 'fbclid', 'gclid', 'igshid', 'mc_cid', 'mc_eid', 'msclkid', 'srsltid',
]);

export function normalizeProductUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only credential-free public HTTP(S) URLs are allowed.');
  }
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  url.hash = '';
  const removable: string[] = [];
  url.searchParams.forEach((_value, key) => {
    const normalized = key.toLowerCase();
    if (normalized.startsWith('utm_') || TRACKING_PARAMETERS.has(normalized)) removable.push(key);
  });
  for (const key of removable) url.searchParams.delete(key);
  return url.toString();
}

export function shoppingItemKey(candidateKind: CandidateKind, canonicalUrl: string, variantOrSize: string | null) {
  const normalizedSelection = variantOrSize?.trim().replace(/\s+/g, ' ').toLowerCase() ?? '';
  return createHash('sha256')
    .update(JSON.stringify([candidateKind, normalizeProductUrl(canonicalUrl), normalizedSelection]))
    .digest('hex');
}

export function isCartEligible(kind: CandidateKind) {
  return (CART_ELIGIBLE_CANDIDATE_KINDS as readonly string[]).includes(kind);
}

export function normalizeBoardTitle(title: string) {
  return title.trim().replace(/\s+/g, ' ');
}
