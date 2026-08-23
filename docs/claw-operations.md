# Claw beta operations

## Security and ownership

- Supabase is canonical for every live shared release and every private user artifact. Do not add live prompt or skill content to a repository.
- Founder access is a UUID membership check in `public.claw_admins`. Email addresses and client-side route guards do not grant access.
- The landing-page service-role key and Apt Server database/service keys are server-only. The mobile app receives only the Supabase URL, publishable key, and local Apt API URL.
- One opaque Hermes profile, stable session, state database, provider credential, and gateway process belong to one Supabase user. Never enable multiplex mode.
- Exact coordinates are foreground, point-of-need inputs. They are allowed only in the active mobile-to-server request and in-memory run; never copy them into Hermes instructions, browser tools, messages, knowledge, Hunts, proposals, or logs. The mobile app reverse-geocodes once and sends a bounded city/region/postal/country label for browser research; only that coarse label may be stored with a Hunt.

## Required operator inputs

Before release 1 can be tested or published, an operator must provide:

1. the independently verified Supabase Auth UUID for each authorized founder;
2. server-only Supabase variables in the founder-console deployment;
3. a Chromium-family browser usable by the pinned Hermes `agent-browser` runtime;
4. founder-reviewed release content authored through `/admin`;
5. the agreed ten-profile fixtures and final iOS location permission copy.

There is no commerce-search endpoint or commerce API key. During a Hunt, Hermes launches its browser, uses `browser_navigate` to open a public search engine and relevant merchant/store sites, interacts with read-only search/filter/location flows, and inspects current result pages. The Apt-managed `apt-hunt-browser-policy` plugin removes upstream Hermes' API-backed `web_search` fallback from the model surface, and provisioning fails if the required browser primitives are absent. The agent then calls `apt_commerce_hunt` with at most five typed candidates. Apt validates the candidate schema, vertical, freshness, public credential-free source URLs, DNS destinations, and coarse-location requirement before recording the Hunt. The browser boundary forbids authentication, accounts, contact/payment entry, terms acceptance, carts, checkout, purchases, orders, reservations, scheduling, merchant contact, and tracking.

## Founder access

After independently verifying the intended Auth UUID, grant access from a protected Apt Server checkout:

```bash
npm run grant-founder -- --user-id <founder-auth-uuid>
```

Revoke with an exact confirmation:

```bash
npm run revoke-founder -- --user-id <founder-auth-uuid> --confirm <same-founder-auth-uuid>
```

Then place `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` in the landing-page server environment. Visit `/admin`; authenticated UUIDs absent from `claw_admins` receive a 403 view and no private Claw data.

## Release workflow

1. Create a draft or clone a published release in `/admin`.
2. Author the enabled core, Soul template, policy, `intent.retail`, `intent.grocery`, and `intent.food` documents. Shared skills require `SKILL.md` YAML frontmatter whose `name` equals the document key and whose `description` is non-empty.
3. Enable exactly `memory`, `session_search`, `skills`, `browser`, and `apt_bridge`. Other capability keys and other MCP servers are rejected in both application and database code. The browser capability is restricted by the code-level read-only commerce-Hunt boundary.
4. Review pending sanitized proposals; acceptance only changes the selected draft and never mutates a published release.
5. Run Validate and inspect Diff. Add a meaningful publish note.
6. Publish. A database advisory lock, expected revision, checksums, and one-published-release constraint make publish/archive atomic.
7. Roll back by cloning a known published/archived version into a new version and publishing that clone. Published rows remain immutable audit evidence.

No shared content is seeded by a migration. Release 1 remains founder-authored and founder-reviewed.

## Verification and rollout

Before applying a migration or changing Hermes:

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:claw-db-live
HERMES_CLI=.local/hermes-v2026.8.19/bin/hermes npm run test:hermes-capability
```

`test:claw-db-live` uses a ready beta UUID to exercise founder authorization,
revision conflicts, the required browser capability, validation, publishing, compiler checksum parity,
immutability, and clone-based rollback inside one database transaction. It
rolls back the temporary founder and release rows before reporting success.

After a cofounder publishes Release 1 and the local stack is healthy, run the public-API smoke with the opt-in browser Hunt check:

```bash
npm run test:e2e-live -- --user-a <founder-a-uuid> --user-b <founder-b-uuid> --verify-hunt true
```

This intentionally creates beta chat/run rows and one real read-only Hunt. It compares the Hermes session trace before and after the Hunt, requiring `browser_navigate`, `browser_snapshot`, and at least one browser click/type/press while rejecting `web_search`. It also requires one to five current retail candidates, a persisted source link in the response, only the coarse location label, and no exact test coordinates in the response or Hunt record. Run it only after founder publication; unlike `test:claw-db-live`, it is not rolled back.

Apply `supabase/migrations` through the Supabase migration workflow, then run both security and performance advisors. Confirm RLS is enabled and forced, `anon`/`authenticated` lack table/function access, and only `service_role` can execute founder RPCs.

Provision or reconfigure each selected beta user, start the one-process-per-profile local stack, and run the live two-user harness. Run the ten-profile all-pairs isolation fixture before expanding the beta.

Physical-device sign-off must record:

- Robel Kebede’s iPhone UAT for ordinary Reply, retail/grocery/food Hunt, location allow/deny/stale fallback, learning continuity, stop, and release rollback;
- Robel Bruk’s independent Mac/iPhone local-stack smoke test;
- no cross-user USER/MEMORY/Soul/skill/knowledge/history/Hunt leakage across ten profiles;
- release number/checksum and the relevant CI, migration, advisor, and PR links.
