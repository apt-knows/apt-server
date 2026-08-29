import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { AppError } from '../errors.js';
import {
  isCartEligible,
  SHOPPING_LIMITS,
  type CandidateKind,
  type ResolvedProductReference,
  type ResolvedShoppingSnapshot,
  type ShoppingBoardDetail,
  type ShoppingBoardPreview,
  type ShoppingItem,
  type ShoppingListEntry,
  type ShoppingListKind,
  type ShoppingSummary,
} from './domain.js';

interface ShoppingItemRow extends QueryResultRow {
  id: string;
  source_kind: ShoppingItem['sourceKind'];
  source_hunt_id: string | null;
  source_candidate_id: string | null;
  feed_fixture_id: string | null;
  vertical: ShoppingItem['vertical'];
  candidate_kind: CandidateKind;
  item_name: string;
  merchant_name: string;
  canonical_url: string;
  source_url: string;
  variant_or_size: string | null;
  image_url: string | null;
  current_price: string | null;
  currency: string | null;
  price_qualifier: string | null;
  availability: string | null;
  fulfillment_or_store_context: string | null;
  verification_status: ShoppingItem['verificationStatus'];
  observed_at: Date;
  metadata: {
    matched_constraints?: string[];
    tradeoffs?: string[];
    personalization_reasons?: string[];
  };
  list_kind: ShoppingListKind | null;
  quantity: number | null;
  board_ids: string[];
  created_at: Date;
  updated_at: Date;
  membership_created_at?: Date;
  membership_updated_at?: Date;
}

interface BoardRow extends QueryResultRow {
  id: string;
  title: string;
  description: string | null;
  context_summary: string;
  item_count: string;
  thumbnails: string[];
  created_at: Date;
  updated_at: Date;
}

interface HuntCandidatesRow extends QueryResultRow {
  candidates: unknown;
}

interface CountRow extends QueryResultRow { count: string }

export interface ShoppingItemMutation {
  item: ShoppingItem | ShoppingListEntry;
  changed: boolean;
  movedFrom: ShoppingListKind | null;
}

export interface ShoppingBoardMutation {
  board: ShoppingBoardDetail;
  changed: boolean;
}

export interface ShoppingBoardItemMutation {
  board: ShoppingBoardDetail;
  item: ShoppingItem;
  changed: boolean;
}

export interface ShoppingBoardPatch {
  title?: string;
  description?: string | null;
  contextSummary?: string;
  expectedUpdatedAt: string;
}

export interface ShoppingRepository {
  findHuntCandidate(userId: string, huntId: string, candidateId: string): Promise<unknown | null>;
  getSummary(userId: string): Promise<ShoppingSummary>;
  getItem(userId: string, itemId: string): Promise<ShoppingItem>;
  getList(userId: string, listKind: ShoppingListKind): Promise<ShoppingListEntry[]>;
  setListMembership(userId: string, reference: ResolvedProductReference, listKind: ShoppingListKind): Promise<ShoppingItemMutation>;
  setCartQuantity(userId: string, itemId: string, quantity: number): Promise<ShoppingItemMutation>;
  removeListMembership(userId: string, itemId: string, listKind: ShoppingListKind): Promise<ShoppingItemMutation>;
  listBoards(userId: string): Promise<ShoppingBoardPreview[]>;
  getBoard(userId: string, boardId: string): Promise<ShoppingBoardDetail>;
  createBoard(userId: string, title: string, description: string | null, contextSummary: string): Promise<ShoppingBoardMutation>;
  updateBoard(userId: string, boardId: string, patch: ShoppingBoardPatch): Promise<ShoppingBoardMutation>;
  deleteBoard(userId: string, boardId: string): Promise<ShoppingBoardMutation>;
  addBoardItem(userId: string, boardId: string, reference: ResolvedProductReference): Promise<ShoppingBoardItemMutation>;
  removeBoardItem(userId: string, boardId: string, itemId: string): Promise<ShoppingBoardItemMutation>;
  close(): Promise<void>;
}

const ITEM_COLUMNS = `
  i.id, i.source_kind, i.source_hunt_id, i.source_candidate_id, i.feed_fixture_id,
  i.vertical, i.candidate_kind, i.item_name, i.merchant_name, i.canonical_url,
  i.source_url, i.variant_or_size, i.image_url, i.current_price, i.currency,
  i.price_qualifier, i.availability, i.fulfillment_or_store_context,
  i.verification_status, i.observed_at, i.metadata, i.created_at, i.updated_at,
  le.list_kind, le.quantity,
  le.created_at as membership_created_at, le.updated_at as membership_updated_at,
  coalesce((
    select array_agg(sbi.board_id order by sbi.board_id)
    from public.shopping_board_items sbi
    where sbi.user_id = i.user_id and sbi.shopping_item_id = i.id
  ), '{}'::uuid[]) as board_ids`;

export class PostgresShoppingRepository implements ShoppingRepository {
  constructor(private readonly pool: Pool) {}

  static create(databaseUrl: string, ssl: boolean) {
    return new PostgresShoppingRepository(new Pool({
      connectionString: databaseUrl,
      max: 5,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
    }));
  }

  async close() {
    await this.pool.end();
  }

  async findHuntCandidate(userId: string, huntId: string, candidateId: string) {
    const result = await this.pool.query<HuntCandidatesRow>(
      `select candidates from public.commerce_hunts
       where id = $1 and user_id = $2 and status = 'completed'`,
      [huntId, userId],
    );
    const candidates = result.rows[0]?.candidates;
    if (!Array.isArray(candidates)) return null;
    return candidates.find((candidate) => isRecord(candidate) && candidate.candidate_id === candidateId) ?? null;
  }

  async getSummary(userId: string): Promise<ShoppingSummary> {
    const [counts, subtotals] = await Promise.all([
      this.pool.query<{
        cart_total_quantity: string;
        wishlist_item_count: string;
        board_count: string;
        unavailable_price_count: string;
      } & QueryResultRow>(
        `select
           coalesce((select sum(quantity) from public.shopping_list_entries where user_id = $1 and list_kind = 'cart'), 0) as cart_total_quantity,
           (select count(*) from public.shopping_list_entries where user_id = $1 and list_kind = 'wishlist') as wishlist_item_count,
           (select count(*) from public.shopping_boards where user_id = $1) as board_count,
           (select count(*) from public.shopping_list_entries le
              join public.shopping_items i on i.user_id = le.user_id and i.id = le.shopping_item_id
            where le.user_id = $1 and le.list_kind = 'cart' and i.current_price is null) as unavailable_price_count`,
        [userId],
      ),
      this.pool.query<{ currency: string; amount: string } & QueryResultRow>(
        `select i.currency, sum(i.current_price * le.quantity)::numeric(16,2) as amount
         from public.shopping_list_entries le
         join public.shopping_items i on i.user_id = le.user_id and i.id = le.shopping_item_id
         where le.user_id = $1 and le.list_kind = 'cart' and i.current_price is not null
         group by i.currency order by i.currency`,
        [userId],
      ),
    ]);
    const row = counts.rows[0];
    return {
      cartTotalQuantity: Number(row?.cart_total_quantity ?? 0),
      wishlistItemCount: Number(row?.wishlist_item_count ?? 0),
      boardCount: Number(row?.board_count ?? 0),
      unavailablePriceCount: Number(row?.unavailable_price_count ?? 0),
      subtotals: subtotals.rows.map((subtotal) => ({ currency: subtotal.currency, amount: Number(subtotal.amount) })),
    };
  }

  async getItem(userId: string, itemId: string) {
    const result = await this.pool.query<ShoppingItemRow>(
      `select ${ITEM_COLUMNS}
       from public.shopping_items i
       left join public.shopping_list_entries le
         on le.user_id = i.user_id and le.shopping_item_id = i.id
       where i.user_id = $1 and i.id = $2`,
      [userId, itemId],
    );
    const row = result.rows[0];
    if (!row) throw new AppError('SHOPPING_ITEM_NOT_FOUND', 'Shopping item not found.');
    return itemFromRow(row);
  }

  async getList(userId: string, listKind: ShoppingListKind) {
    const result = await this.pool.query<ShoppingItemRow>(
      `select ${ITEM_COLUMNS}
       from public.shopping_list_entries le
       join public.shopping_items i on i.user_id = le.user_id and i.id = le.shopping_item_id
       where le.user_id = $1 and le.list_kind = $2
       order by le.updated_at desc, i.id`,
      [userId, listKind],
    );
    return result.rows.map(listEntryFromRow);
  }

  async setListMembership(userId: string, reference: ResolvedProductReference, listKind: ShoppingListKind) {
    return this.withTransaction(async (client) => {
      await this.lockUserScope(client, userId, 'lists');
      const item = await this.resolveItem(client, userId, reference);
      if (listKind === 'cart' && !isCartEligible(item.candidateKind)) {
        throw new AppError('ITEM_NOT_CART_ELIGIBLE', 'This saved find is not eligible for Apt Cart.');
      }
      const existing = await client.query<{ list_kind: ShoppingListKind; quantity: number } & QueryResultRow>(
        `select list_kind, quantity from public.shopping_list_entries
         where user_id = $1 and shopping_item_id = $2 for update`,
        [userId, item.id],
      );
      const current = existing.rows[0];
      if (current?.list_kind !== listKind) {
        const count = await client.query<CountRow>(
          `select count(*) from public.shopping_list_entries where user_id = $1 and list_kind = $2`,
          [userId, listKind],
        );
        const maximum = listKind === 'cart' ? SHOPPING_LIMITS.cartEntries : SHOPPING_LIMITS.wishlistEntries;
        if (Number(count.rows[0]?.count ?? 0) >= maximum) {
          throw new AppError('SHOPPING_LIMIT_REACHED', `The ${listKind} beta limit has been reached.`);
        }
      }
      await client.query(
        `insert into public.shopping_list_entries(user_id, shopping_item_id, list_kind, quantity)
         values ($1, $2, $3, 1)
         on conflict (user_id, shopping_item_id) do update
         set list_kind = excluded.list_kind,
             quantity = case
               when shopping_list_entries.list_kind = excluded.list_kind then shopping_list_entries.quantity
               else 1
             end`,
        [userId, item.id, listKind],
      );
      const updated = await this.getItemWithClient(client, userId, item.id);
      return {
        item: listEntryFromItemRow(updated),
        changed: current?.list_kind !== listKind,
        movedFrom: current && current.list_kind !== listKind ? current.list_kind : null,
      };
    });
  }

  async setCartQuantity(userId: string, itemId: string, quantity: number) {
    return this.withTransaction(async (client) => {
      const existing = await client.query<{ quantity: number } & QueryResultRow>(
        `select quantity from public.shopping_list_entries
         where user_id = $1 and shopping_item_id = $2 and list_kind = 'cart' for update`,
        [userId, itemId],
      );
      const row = existing.rows[0];
      if (!row) throw new AppError('SHOPPING_ITEM_NOT_FOUND', 'Cart item not found.');
      if (row.quantity !== quantity) {
        await client.query(
          `update public.shopping_list_entries set quantity = $3
           where user_id = $1 and shopping_item_id = $2 and list_kind = 'cart'`,
          [userId, itemId, quantity],
        );
      }
      const updated = await this.getItemWithClient(client, userId, itemId);
      return { item: listEntryFromItemRow(updated), changed: row.quantity !== quantity, movedFrom: null };
    });
  }

  async removeListMembership(userId: string, itemId: string, listKind: ShoppingListKind) {
    return this.withTransaction(async (client) => {
      await this.requireItemWithClient(client, userId, itemId);
      const deleted = await client.query(
        `delete from public.shopping_list_entries
         where user_id = $1 and shopping_item_id = $2 and list_kind = $3`,
        [userId, itemId, listKind],
      );
      const item = await this.getItemWithClient(client, userId, itemId);
      return { item: itemFromRow(item), changed: Boolean(deleted.rowCount), movedFrom: null };
    });
  }

  async listBoards(userId: string) {
    const result = await this.pool.query<BoardRow>(boardListSql('where b.user_id = $1'), [userId]);
    return result.rows.map(boardPreviewFromRow);
  }

  async getBoard(userId: string, boardId: string): Promise<ShoppingBoardDetail> {
    const board = await this.pool.query<BoardRow>(boardListSql('where b.user_id = $1 and b.id = $2'), [userId, boardId]);
    const boardRow = board.rows[0];
    if (!boardRow) throw new AppError('BOARD_NOT_FOUND', 'Board not found.');
    const items = await this.pool.query<ShoppingItemRow>(
      `select ${ITEM_COLUMNS}
       from public.shopping_board_items bi
       join public.shopping_items i on i.user_id = bi.user_id and i.id = bi.shopping_item_id
       left join public.shopping_list_entries le on le.user_id = i.user_id and le.shopping_item_id = i.id
       where bi.user_id = $1 and bi.board_id = $2
       order by bi.created_at desc, i.id`,
      [userId, boardId],
    );
    return boardDetailFromRow(boardRow, items.rows.map(itemFromRow));
  }

  async createBoard(userId: string, title: string, description: string | null, contextSummary: string) {
    const result = await this.withTransaction(async (client) => {
      await this.lockUserScope(client, userId, 'boards');
      const existing = await client.query<{ id: string } & QueryResultRow>(
        `select id from public.shopping_boards
         where user_id = $1 and normalized_title = lower(regexp_replace(btrim($2), '\\s+', ' ', 'g'))`,
        [userId, title],
      );
      if (existing.rows[0]) return { id: existing.rows[0].id, changed: false };
      const count = await client.query<CountRow>('select count(*) from public.shopping_boards where user_id = $1', [userId]);
      if (Number(count.rows[0]?.count ?? 0) >= SHOPPING_LIMITS.boardsPerUser) {
        throw new AppError('SHOPPING_LIMIT_REACHED', 'The Board beta limit has been reached.');
      }
      const inserted = await client.query<{ id: string } & QueryResultRow>(
        `insert into public.shopping_boards(user_id, title, description, context_summary)
         values ($1, $2, $3, $4) returning id`,
        [userId, title, description, contextSummary],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('Failed to create Board.');
      return { id: row.id, changed: true };
    });
    return { board: await this.getBoard(userId, result.id), changed: result.changed };
  }

  async updateBoard(userId: string, boardId: string, patch: ShoppingBoardPatch) {
    try {
      const result = await this.withTransaction(async (client) => {
        const currentResult = await client.query<{
          title: string;
          description: string | null;
          context_summary: string;
          updated_at: Date;
        } & QueryResultRow>(
          `select title, description, context_summary, updated_at from public.shopping_boards
           where user_id = $1 and id = $2 for update`,
          [userId, boardId],
        );
        const current = currentResult.rows[0];
        if (!current) throw new AppError('BOARD_NOT_FOUND', 'Board not found.');
        if (current.updated_at.toISOString() !== patch.expectedUpdatedAt) {
          throw new AppError('BOARD_UPDATE_CONFLICT', 'Board changed since it was loaded. Refresh and try again.');
        }
        const next = {
          title: patch.title ?? current.title,
          description: patch.description === undefined ? current.description : patch.description,
          contextSummary: patch.contextSummary ?? current.context_summary,
        };
        const changed = next.title !== current.title || next.description !== current.description ||
          next.contextSummary !== current.context_summary;
        if (changed) {
          await client.query(
            `update public.shopping_boards
             set title = $3, description = $4, context_summary = $5
             where user_id = $1 and id = $2`,
            [userId, boardId, next.title, next.description, next.contextSummary],
          );
        }
        return changed;
      });
      return { board: await this.getBoard(userId, boardId), changed: result };
    } catch (error) {
      if (postgresCode(error) === '23505') {
        throw new AppError('BOARD_NAME_CONFLICT', 'A Board with this name already exists.');
      }
      throw error;
    }
  }

  async deleteBoard(userId: string, boardId: string) {
    const board = await this.getBoard(userId, boardId);
    await this.pool.query('delete from public.shopping_boards where user_id = $1 and id = $2', [userId, boardId]);
    return { board, changed: true };
  }

  async addBoardItem(userId: string, boardId: string, reference: ResolvedProductReference) {
    const result = await this.withTransaction(async (client) => {
      await this.lockUserScope(client, userId, `board:${boardId}`);
      await this.requireBoardWithClient(client, userId, boardId, true);
      const item = await this.resolveItem(client, userId, reference);
      const existing = await client.query(
        `select 1 from public.shopping_board_items
         where user_id = $1 and board_id = $2 and shopping_item_id = $3`,
        [userId, boardId, item.id],
      );
      if (existing.rowCount) return { itemId: item.id, changed: false };
      const count = await client.query<CountRow>(
        'select count(*) from public.shopping_board_items where user_id = $1 and board_id = $2',
        [userId, boardId],
      );
      if (Number(count.rows[0]?.count ?? 0) >= SHOPPING_LIMITS.boardItems) {
        throw new AppError('SHOPPING_LIMIT_REACHED', 'The Board item beta limit has been reached.');
      }
      await client.query(
        `insert into public.shopping_board_items(user_id, board_id, shopping_item_id)
         values ($1, $2, $3) on conflict (board_id, shopping_item_id) do nothing`,
        [userId, boardId, item.id],
      );
      return { itemId: item.id, changed: true };
    });
    const [board, item] = await Promise.all([this.getBoard(userId, boardId), this.getItem(userId, result.itemId)]);
    return { board, item, changed: result.changed };
  }

  async removeBoardItem(userId: string, boardId: string, itemId: string) {
    const changed = await this.withTransaction(async (client) => {
      await this.requireBoardWithClient(client, userId, boardId, true);
      await this.requireItemWithClient(client, userId, itemId);
      const deleted = await client.query(
        `delete from public.shopping_board_items
         where user_id = $1 and board_id = $2 and shopping_item_id = $3`,
        [userId, boardId, itemId],
      );
      return Boolean(deleted.rowCount);
    });
    const [board, item] = await Promise.all([this.getBoard(userId, boardId), this.getItem(userId, itemId)]);
    return { board, item, changed };
  }

  private async resolveItem(client: PoolClient, userId: string, reference: ResolvedProductReference) {
    if (reference.kind === 'existing_item') {
      return itemFromRow(await this.getItemWithClient(client, userId, reference.shoppingItemId));
    }
    const value = reference.value;
    const row = value.sourceKind === 'hunt_candidate'
      ? await this.upsertHuntSnapshot(client, userId, value)
      : await this.insertFeedSnapshot(client, userId, value);
    return itemFromRow(await this.getItemWithClient(client, userId, row.id));
  }

  private async upsertHuntSnapshot(client: PoolClient, userId: string, value: ResolvedShoppingSnapshot) {
    const result = await client.query<{ id: string } & QueryResultRow>(
      `${snapshotInsertSql()}
       on conflict (user_id, item_key) do update set
         source_kind = excluded.source_kind,
         source_hunt_id = excluded.source_hunt_id,
         source_candidate_id = excluded.source_candidate_id,
         feed_fixture_id = null,
         vertical = excluded.vertical,
         candidate_kind = excluded.candidate_kind,
         item_name = excluded.item_name,
         merchant_name = excluded.merchant_name,
         canonical_url = excluded.canonical_url,
         source_url = excluded.source_url,
         variant_or_size = excluded.variant_or_size,
         image_url = excluded.image_url,
         current_price = excluded.current_price,
         currency = excluded.currency,
         price_qualifier = excluded.price_qualifier,
         availability = excluded.availability,
         fulfillment_or_store_context = excluded.fulfillment_or_store_context,
         verification_status = excluded.verification_status,
         observed_at = excluded.observed_at,
         metadata = excluded.metadata
       returning id`,
      snapshotValues(userId, value),
    );
    const row = result.rows[0];
    if (!row) throw new Error('Failed to promote Hunt candidate.');
    return row;
  }

  private async insertFeedSnapshot(client: PoolClient, userId: string, value: ResolvedShoppingSnapshot) {
    const inserted = await client.query<{ id: string } & QueryResultRow>(
      `${snapshotInsertSql()} on conflict (user_id, item_key) do nothing returning id`,
      snapshotValues(userId, value),
    );
    const existing = inserted.rows[0] ?? (await client.query<{ id: string } & QueryResultRow>(
      'select id from public.shopping_items where user_id = $1 and item_key = $2',
      [userId, value.itemKey],
    )).rows[0];
    if (!existing) throw new Error('Failed to resolve Feed fixture.');
    return existing;
  }

  private async getItemWithClient(client: PoolClient, userId: string, itemId: string) {
    const result = await client.query<ShoppingItemRow>(
      `select ${ITEM_COLUMNS}
       from public.shopping_items i
       left join public.shopping_list_entries le on le.user_id = i.user_id and le.shopping_item_id = i.id
       where i.user_id = $1 and i.id = $2`,
      [userId, itemId],
    );
    const row = result.rows[0];
    if (!row) throw new AppError('SHOPPING_ITEM_NOT_FOUND', 'Shopping item not found.');
    return row;
  }

  private async requireItemWithClient(client: PoolClient, userId: string, itemId: string) {
    const result = await client.query('select 1 from public.shopping_items where user_id = $1 and id = $2', [userId, itemId]);
    if (!result.rowCount) throw new AppError('SHOPPING_ITEM_NOT_FOUND', 'Shopping item not found.');
  }

  private async requireBoardWithClient(client: PoolClient, userId: string, boardId: string, lock: boolean) {
    const result = await client.query(
      `select 1 from public.shopping_boards where user_id = $1 and id = $2${lock ? ' for update' : ''}`,
      [userId, boardId],
    );
    if (!result.rowCount) throw new AppError('BOARD_NOT_FOUND', 'Board not found.');
  }

  private async lockUserScope(client: PoolClient, userId: string, scope: string) {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`apt-shopping:${userId}:${scope}`]);
  }

  private async withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await operation(client);
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

function snapshotInsertSql() {
  return `insert into public.shopping_items(
    user_id, item_key, source_kind, source_hunt_id, source_candidate_id, feed_fixture_id,
    vertical, candidate_kind, item_name, merchant_name, canonical_url, source_url,
    variant_or_size, image_url, current_price, currency, price_qualifier, availability,
    fulfillment_or_store_context, verification_status, observed_at, metadata
  ) values (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
    $13, $14, $15, $16, $17, $18, $19, $20, $21, $22
  )`;
}

function snapshotValues(userId: string, value: ResolvedShoppingSnapshot) {
  const snapshot = value.snapshot;
  return [
    userId, value.itemKey, value.sourceKind, value.sourceHuntId, value.sourceCandidateId, value.feedFixtureId,
    snapshot.vertical, snapshot.candidate_kind, snapshot.item_name, snapshot.merchant_name,
    snapshot.canonical_url, snapshot.source_url, snapshot.variant_or_size, snapshot.image_url,
    snapshot.current_price, snapshot.currency, snapshot.price_qualifier, snapshot.availability,
    snapshot.fulfillment_or_store_context, snapshot.verification_status, snapshot.observed_at,
    {
      matched_constraints: snapshot.matched_constraints,
      tradeoffs: snapshot.tradeoffs,
      personalization_reasons: snapshot.personalization_reasons,
    },
  ];
}

function boardListSql(where: string) {
  return `select b.id, b.title, b.description, b.context_summary, b.created_at, b.updated_at,
    (select count(*) from public.shopping_board_items bi where bi.user_id = b.user_id and bi.board_id = b.id) as item_count,
    coalesce((
      select array_agg(images.image_url order by images.created_at desc)
      from (
        select i.image_url, bi.created_at
        from public.shopping_board_items bi
        join public.shopping_items i on i.user_id = bi.user_id and i.id = bi.shopping_item_id
        where bi.user_id = b.user_id and bi.board_id = b.id and i.image_url is not null
        order by bi.created_at desc limit 4
      ) images
    ), '{}'::text[]) as thumbnails
    from public.shopping_boards b ${where}
    order by b.updated_at desc, b.id`;
}

function itemFromRow(row: ShoppingItemRow): ShoppingItem {
  return {
    id: row.id,
    sourceKind: row.source_kind,
    sourceHuntId: row.source_hunt_id,
    sourceCandidateId: row.source_candidate_id,
    feedFixtureId: row.feed_fixture_id,
    vertical: row.vertical,
    candidateKind: row.candidate_kind,
    cartEligible: isCartEligible(row.candidate_kind),
    itemName: row.item_name,
    merchantName: row.merchant_name,
    canonicalUrl: row.canonical_url,
    sourceUrl: row.source_url,
    variantOrSize: row.variant_or_size,
    imageUrl: row.image_url,
    currentPrice: row.current_price === null ? null : Number(row.current_price),
    currency: row.currency,
    priceQualifier: row.price_qualifier,
    availability: row.availability,
    fulfillmentOrStoreContext: row.fulfillment_or_store_context,
    verificationStatus: row.verification_status,
    observedAt: row.observed_at.toISOString(),
    matchedConstraints: row.metadata.matched_constraints ?? [],
    tradeoffs: row.metadata.tradeoffs ?? [],
    personalizationReasons: row.metadata.personalization_reasons ?? [],
    listKind: row.list_kind,
    quantity: row.quantity,
    boardIds: row.board_ids.map(String),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function listEntryFromRow(row: ShoppingItemRow): ShoppingListEntry {
  const item = itemFromRow(row);
  return listEntryFromItemRow(row, item);
}

function listEntryFromItemRow(row: ShoppingItemRow, item = itemFromRow(row)): ShoppingListEntry {
  if (!item.listKind || item.quantity === null || !row.membership_created_at || !row.membership_updated_at) {
    throw new Error('Expected Shopping list membership.');
  }
  return {
    ...item,
    listKind: item.listKind,
    quantity: item.quantity,
    membershipCreatedAt: row.membership_created_at.toISOString(),
    membershipUpdatedAt: row.membership_updated_at.toISOString(),
  };
}

function boardPreviewFromRow(row: BoardRow): ShoppingBoardPreview {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    contextSummaryPreview: row.context_summary.slice(0, 240),
    itemCount: Number(row.item_count),
    thumbnails: row.thumbnails,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function boardDetailFromRow(row: BoardRow, items: ShoppingItem[]): ShoppingBoardDetail {
  const preview = boardPreviewFromRow(row);
  const { contextSummaryPreview: _preview, ...base } = preview;
  return { ...base, contextSummary: row.context_summary, items };
}

function postgresCode(error: unknown) {
  return isRecord(error) && typeof error.code === 'string' ? error.code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
