import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(fileURLToPath(new URL(
  '../supabase/migrations/20260826000538_shopping_foundation.sql',
  import.meta.url,
)), 'utf8');

describe('Shopping migration invariants', () => {
  it('creates exactly the four canonical Shopping tables with forced RLS and denied clients', () => {
    for (const table of ['shopping_items', 'shopping_list_entries', 'shopping_boards', 'shopping_board_items']) {
      expect(migration).toContain(`create table public.${table}`);
      expect(migration).toContain(`alter table public.${table} enable row level security`);
      expect(migration).toContain(`alter table public.${table} force row level security`);
      expect(migration).toContain(`revoke all on table public.${table} from public, anon, authenticated`);
    }
    expect(migration.match(/create table public\.shopping_/g)).toHaveLength(4);
    expect(migration.toLowerCase()).not.toContain('security definer');
    expect(migration.toLowerCase()).not.toContain('create policy');
  });

  it('makes Cart and Wishlist mutually exclusive and bounds quantity structurally', () => {
    expect(migration).toContain('primary key (user_id, shopping_item_id)');
    expect(migration).toContain("list_kind in ('cart', 'wishlist')");
    expect(migration).toContain("list_kind = 'cart' and quantity between 1 and 99");
    expect(migration).toContain("list_kind = 'wishlist' and quantity = 1");
    expect(migration).toContain('shopping_list_entries_cart_eligibility');
  });

  it('uses composite owner foreign keys and independent many-to-many Board membership', () => {
    expect(migration).toContain('shopping_items_user_id_id_unique unique (user_id, id)');
    expect(migration).toContain('shopping_boards_user_id_id_unique unique (user_id, id)');
    expect(migration).toContain('shopping_board_items_board_owner_fk foreign key (user_id, board_id)');
    expect(migration).toContain('shopping_board_items_item_owner_fk foreign key (user_id, shopping_item_id)');
    expect(migration).toContain('primary key (board_id, shopping_item_id)');
  });

  it('covers every ownership foreign-key path with an index prefix', () => {
    expect(migration).toContain('shopping_items_hunt_owner_idx');
    expect(migration).toContain('shopping_list_entries_user_kind_updated_desc_idx');
    expect(migration).toContain('shopping_boards_user_updated_desc_idx');
    expect(migration).toContain('shopping_board_items_user_board_created_idx');
    expect(migration).toContain('shopping_board_items_user_item_board_idx');
  });
});
