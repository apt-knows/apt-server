-- APT-9 canonical, server-owned Shopping state. No fixture rows or shared-release
-- content are seeded here: every real user begins with empty private state.

alter table public.commerce_hunts
  add constraint commerce_hunts_user_id_id_unique unique (user_id, id);

create table public.shopping_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  item_key text not null check (item_key ~ '^[a-f0-9]{64}$'),
  source_kind text not null check (source_kind in ('hunt_candidate', 'feed_fixture')),
  source_hunt_id uuid,
  source_candidate_id text,
  feed_fixture_id text,
  vertical text not null check (vertical in ('retail', 'grocery', 'food')),
  candidate_kind text not null check (
    candidate_kind in ('product', 'grocery_item', 'menu_item', 'merchant_or_place', 'other_find')
  ),
  item_name text not null check (char_length(btrim(item_name)) between 1 and 300),
  merchant_name text not null check (char_length(btrim(merchant_name)) between 1 and 200),
  canonical_url text not null check (
    char_length(canonical_url) between 1 and 2048 and canonical_url ~* '^https?://'
  ),
  source_url text not null check (
    char_length(source_url) between 1 and 2048 and source_url ~* '^https?://'
  ),
  variant_or_size text check (variant_or_size is null or char_length(btrim(variant_or_size)) between 1 and 200),
  image_url text check (
    image_url is null or (char_length(image_url) between 1 and 2048 and image_url ~* '^https?://')
  ),
  current_price numeric(14, 2) check (current_price is null or current_price between 0 and 99999999.99),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  price_qualifier text check (price_qualifier is null or char_length(btrim(price_qualifier)) between 1 and 160),
  availability text check (availability is null or char_length(btrim(availability)) between 1 and 200),
  fulfillment_or_store_context text check (
    fulfillment_or_store_context is null
    or char_length(btrim(fulfillment_or_store_context)) between 1 and 240
  ),
  verification_status text not null check (
    verification_status in ('verified', 'partially_verified', 'unconfirmed')
  ),
  observed_at timestamptz not null,
  metadata jsonb not null default '{"matched_constraints":[],"tradeoffs":[],"personalization_reasons":[]}'::jsonb
    check (
      jsonb_typeof(metadata) = 'object'
      and jsonb_typeof(metadata -> 'matched_constraints') = 'array'
      and jsonb_typeof(metadata -> 'tradeoffs') = 'array'
      and jsonb_typeof(metadata -> 'personalization_reasons') = 'array'
      and octet_length(metadata::text) <= 20000
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shopping_items_user_item_key_unique unique (user_id, item_key),
  constraint shopping_items_user_id_id_unique unique (user_id, id),
  constraint shopping_items_price_currency_check check (
    (current_price is null and currency is null)
    or (current_price is not null and currency is not null)
  ),
  constraint shopping_items_source_fields_check check (
    (
      source_kind = 'hunt_candidate'
      and source_hunt_id is not null
      and source_candidate_id ~ '^[a-zA-Z0-9_-]{1,64}$'
      and feed_fixture_id is null
    )
    or (
      source_kind = 'feed_fixture'
      and source_hunt_id is null
      and source_candidate_id is null
      and feed_fixture_id ~ '^[a-zA-Z0-9_-]{1,128}$'
    )
  ),
  constraint shopping_items_hunt_owner_fk foreign key (user_id, source_hunt_id)
    references public.commerce_hunts(user_id, id) on delete restrict
);

create table public.shopping_list_entries (
  user_id uuid not null references auth.users(id) on delete cascade,
  shopping_item_id uuid not null,
  list_kind text not null check (list_kind in ('cart', 'wishlist')),
  quantity integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, shopping_item_id),
  constraint shopping_list_entries_item_owner_fk foreign key (user_id, shopping_item_id)
    references public.shopping_items(user_id, id) on delete cascade,
  constraint shopping_list_entries_quantity_check check (
    (list_kind = 'cart' and quantity between 1 and 99)
    or (list_kind = 'wishlist' and quantity = 1)
  )
);

create table public.shopping_boards (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null check (
    title = btrim(title) and char_length(title) between 1 and 80
  ),
  normalized_title text generated always as (lower(regexp_replace(btrim(title), '\s+', ' ', 'g'))) stored,
  description text check (description is null or char_length(description) <= 1000),
  context_summary text not null default '' check (char_length(context_summary) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shopping_boards_user_title_unique unique (user_id, normalized_title),
  constraint shopping_boards_user_id_id_unique unique (user_id, id)
);

create table public.shopping_board_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  board_id uuid not null,
  shopping_item_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (board_id, shopping_item_id),
  constraint shopping_board_items_board_owner_fk foreign key (user_id, board_id)
    references public.shopping_boards(user_id, id) on delete cascade,
  constraint shopping_board_items_item_owner_fk foreign key (user_id, shopping_item_id)
    references public.shopping_items(user_id, id) on delete cascade
);

create index shopping_items_user_updated_desc_idx
  on public.shopping_items(user_id, updated_at desc);
create index shopping_items_hunt_owner_idx
  on public.shopping_items(user_id, source_hunt_id) where source_hunt_id is not null;
create index shopping_list_entries_user_kind_updated_desc_idx
  on public.shopping_list_entries(user_id, list_kind, updated_at desc);
create index shopping_boards_user_updated_desc_idx
  on public.shopping_boards(user_id, updated_at desc);
create index shopping_board_items_user_board_created_idx
  on public.shopping_board_items(user_id, board_id, created_at desc);
create index shopping_board_items_user_item_board_idx
  on public.shopping_board_items(user_id, shopping_item_id, board_id);

create trigger shopping_items_set_updated_at
before update on public.shopping_items
for each row execute function public.set_updated_at();

create trigger shopping_list_entries_set_updated_at
before update on public.shopping_list_entries
for each row execute function public.set_updated_at();

create trigger shopping_boards_set_updated_at
before update on public.shopping_boards
for each row execute function public.set_updated_at();

create function public.shopping_enforce_cart_eligibility()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.list_kind = 'cart' and not exists (
    select 1
    from public.shopping_items
    where user_id = new.user_id
      and id = new.shopping_item_id
      and candidate_kind in ('product', 'grocery_item', 'menu_item')
  ) then
    raise exception 'Shopping item is not Cart-eligible.' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger shopping_list_entries_cart_eligibility
before insert or update of list_kind, shopping_item_id, user_id on public.shopping_list_entries
for each row execute function public.shopping_enforce_cart_eligibility();

alter table public.shopping_items enable row level security;
alter table public.shopping_list_entries enable row level security;
alter table public.shopping_boards enable row level security;
alter table public.shopping_board_items enable row level security;

alter table public.shopping_items force row level security;
alter table public.shopping_list_entries force row level security;
alter table public.shopping_boards force row level security;
alter table public.shopping_board_items force row level security;

revoke all on table public.shopping_items from public, anon, authenticated;
revoke all on table public.shopping_list_entries from public, anon, authenticated;
revoke all on table public.shopping_boards from public, anon, authenticated;
revoke all on table public.shopping_board_items from public, anon, authenticated;
revoke all on function public.shopping_enforce_cart_eligibility() from public, anon, authenticated;

grant select, insert, update, delete on table public.shopping_items to service_role;
grant select, insert, update, delete on table public.shopping_list_entries to service_role;
grant select, insert, update, delete on table public.shopping_boards to service_role;
grant select, insert, update, delete on table public.shopping_board_items to service_role;
