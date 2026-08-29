import { describe, expect, it } from 'vitest';
import {
  candidateKindSchema,
  isCartEligible,
  normalizeProductUrl,
  productReferenceSchema,
  shoppingItemKey,
} from '../src/shopping/domain.js';

describe('Shopping domain contract', () => {
  it('admits only concrete orderable candidate kinds to Cart', () => {
    expect(isCartEligible('product')).toBe(true);
    expect(isCartEligible('grocery_item')).toBe(true);
    expect(isCartEligible('menu_item')).toBe(true);
    expect(isCartEligible('merchant_or_place')).toBe(false);
    expect(isCartEligible('other_find')).toBe(false);
    expect(() => candidateKindSchema.parse('merchant')).toThrow();
  });

  it('normalizes only safe structural and known tracking URL fields', () => {
    expect(normalizeProductUrl('HTTPS://Shop.Example:443/p/SKU-1?variant=Blue&utm_source=feed&gclid=x#reviews'))
      .toBe('https://shop.example/p/SKU-1?variant=Blue');
    expect(normalizeProductUrl('https://shop.example/p/SKU-1?variant=Blue'))
      .not.toBe(normalizeProductUrl('https://shop.example/p/SKU-1?variant=Black'));
  });

  it('derives a stable per-selection item key without collapsing variants', () => {
    const blue = shoppingItemKey('product', 'https://shop.example/p/1?utm_medium=social', 'Blue / M');
    expect(blue).toBe(shoppingItemKey('product', 'HTTPS://SHOP.EXAMPLE:443/p/1#details', ' blue   / m '));
    expect(blue).not.toBe(shoppingItemKey('product', 'https://shop.example/p/1', 'Black / M'));
    expect(blue).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects model-authored product metadata while accepting the three trusted reference shapes', () => {
    expect(productReferenceSchema.parse({
      kind: 'hunt_candidate', huntId: '11111111-1111-4111-8111-111111111111', candidateId: 'candidate-1',
    })).toBeTruthy();
    expect(productReferenceSchema.parse({
      kind: 'existing_item', shoppingItemId: '22222222-2222-4222-8222-222222222222',
    })).toBeTruthy();
    expect(() => productReferenceSchema.parse({
      kind: 'hunt_candidate', huntId: '11111111-1111-4111-8111-111111111111', candidateId: 'candidate-1',
      currentPrice: 1,
    })).toThrow();
  });
});
