# Apt server

Private messaging backend for Apt’s 10-user beta. The mobile app authenticates with Supabase, this service owns all transcript writes, and each user is mapped to one manually provisioned Hermes profile and stable session.

## Runtime contract

- Node.js `22.22.0`, strict TypeScript, Fastify, PostgreSQL, and Hermes Agent `v2026.8.19` (`0.20.5`).
- Supabase Auth access tokens are required on every `/v1/chat/*` route. A `401` never falls back to an anonymous identity.
- Mobile clients cannot read or write the three chat tables directly. RLS is forced, `anon`/`authenticated` grants are revoked, and only the private server database connection mutates transcripts.
- There is one user-visible thread, one active run per user, and one stable Hermes session per user.
- Before each Runs API submission, the server compiles the currently published Claw release with that user’s private profile, relevant knowledge, previous Hunts, and whole recent messages bounded to 48,000 characters.
- The selected Hermes topology is `per_profile`; see [the Phase 0 result](docs/hermes-capability.md).
- Hermes profiles contain no bundled skills. They expose only memory, session search, bounded browser automation for read-only commerce Hunts, private `private.*` skills, read-only published Apt skills, and the six typed Apt bridge tools.
- Live shared prompts, policies, skills, merchant guidance, and capabilities live only in immutable Supabase releases. This repository contains their compiler and allowlist, not production content.

## Development

```bash
cp .env.example .env
npm ci
npm run typecheck
npm test
npm run build
npm run dev
```

`GET /health` is unauthenticated and returns `503` when PostgreSQL or Hermes is unavailable. It never includes credentials or user data.

### One-command physical iPhone stack

With `apt-server` and `apt-mobile` checked out beside each other and the protected server `.env` configured, connect an unlocked iPhone over USB-C and run this from apt-mobile:

```bash
npm run ios:stack
```

The launcher discovers ready beta mappings, bootstraps pinned Hermes when needed, provisions missing local profiles, starts all per-profile gateways and Apt Server, writes only public/LAN values to the mobile's ignored `.env.local`, then builds, installs, launches, and serves the app. `Ctrl-C` shuts down the complete stack. See [the local phone stack guide](docs/local-phone-stack.md) for new-Mac setup, user selection, networking, and failure behavior.

## API

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/health` | Bounded database and Hermes readiness |
| `GET` | `/v1/chat?before=<sequence>&limit=50` | Read chronological history and the active run |
| `POST` | `/v1/chat/messages` | Idempotently append a user turn, reserve an assistant message, and create a run |
| `GET` | `/v1/chat/runs/:runId` | Read the authenticated user’s run snapshot |
| `GET` | `/v1/chat/runs/:runId/events` | Sanitized SSE: snapshot, assistant delta, and terminal events only |
| `POST` | `/v1/chat/runs/:runId/stop` | Mark stopping and interrupt Hermes when a Hermes run exists |

Message bodies are `{ "clientMessageId": "<uuid>", "content": "...", "location"?: { "latitude": 0, "longitude": 0, "accuracy": 0, "capturedAt": "...", "coarseLabel": "city, region, postal code, country" } }`. Content is normalized and limited to 8,000 characters. Optional coordinates must be foreground-only, accurate to 1,000 meters, and no older than five minutes. Exact coordinates remain in Apt Server memory for the active run and never enter Hermes, browser tools, messages, Hunts, or logs; only the mobile-derived coarse label may be used for browser research and saved with a Hunt. Reusing the same client message ID for the same user returns the original turn; a second active turn returns `RUN_IN_PROGRESS`.

Stable error response:

```json
{ "error": { "code": "AGENT_NOT_PROVISIONED", "message": "Apt chat has not been provisioned for this user." } }
```

## Database

Migrations live under `supabase/migrations` and are already applied to the `aptknows-auth` project. They define:

- `agent_instances`: Supabase user to opaque Hermes profile/session mapping.
- `messages`: keyset-ordered user and assistant transcript with same-owner reply constraints.
- `agent_runs`: request/response ownership constraints and a partial unique index permitting only one active run per user.
- `claw_releases`, `claw_documents`, and `claw_capabilities`: immutable, checksummed shared releases with atomic publish/archive and clone-based rollback.
- `claw_user_*` and `claw_learning_*`: server-only private profiles, FTS knowledge, private skills, audit events, and sanitized founder proposals.
- `commerce_hunts`: private typed Hunt results and source provenance, with PostgreSQL full-text search.

On startup, queued/running/stopping rows are failed with `SERVER_RESTARTED`; Hermes is stopped best-effort and no prompt is replayed.

## Manual beta lifecycle

Provisioning is deliberately operator-only and idempotent. It validates the Supabase user, derives opaque stable identifiers, creates or reconfigures a Hermes profile without bundled skills, installs only the narrow tool/skill policy and profile-bound Apt bridge, writes secrets with mode `0600`, runs Hermes config/MCP/live-turn validation, then upserts the mapping.

```bash
npm run provision-user -- --user-id <supabase-user-uuid>
npm run disable-user -- --user-id <supabase-user-uuid>
npm run delete-user -- --user-id <supabase-user-uuid> --confirm <same-supabase-user-uuid>
npm run grant-founder -- --user-id <supabase-user-uuid>
npm run revoke-founder -- --user-id <supabase-user-uuid> --confirm <same-supabase-user-uuid>
```

Deletion removes the Hermes profile before database records. A failure leaves database ownership records intact so an operator can retry safely.

After provisioning, start exactly one pinned Hermes process/container for that profile. Name it `hermes-<opaque-profile-name>` on the backend network so `HERMES_PROFILE_URL_TEMPLATE=http://hermes-{profile}:8642` resolves it. Never expose port `8642` publicly. Repeat the example service in [docker-compose.example.yml](docker-compose.example.yml) once per beta profile; there is no runtime provisioner.

For local host processes on distinct ports, set `HERMES_PROFILE_URL_MAP` to a JSON object such as `{"apt-opaque-a":"http://127.0.0.1:8642","apt-opaque-b":"http://127.0.0.1:8643"}`. Exact profile names are printed by the provisioning commands. Explicit map entries take precedence over the container-name template.

`HERMES_PROVIDER=openai-api` selects OpenAI directly. If `HERMES_PROVIDER=custom`, `HERMES_PROVIDER_BASE_URL` is required so Hermes cannot silently route the credential through its default aggregator.

## Verification

```bash
HERMES_CLI=/path/to/hermes HERMES_VERSION=v2026.8.19 npm run test:hermes-capability
```

The harness creates two fresh profiles and a deterministic OpenAI-compatible provider, then verifies sequential/concurrent turns, provider context and credential separation, session/history/state isolation, restart isolation, cross-key denial, Apt-only skills, exact Apt bridge discovery, the required browser navigation primitives, disabled transactional/dangerous tools, and stop behavior. It writes [the audit result](docs/hermes-capability-results.json).

Founder release authoring, browser setup, migration checks, rollout, rollback, and physical-iPhone UAT are documented in [the Claw operations guide](docs/claw-operations.md).

With Apt Server and two provisioned per-profile gateways already running, the live harness creates short-lived Supabase sessions without sending email and exercises the public API against the real database and provider:

```bash
npm run test:e2e-live -- --user-a <uuid-a> --user-b <uuid-b>
```

It verifies authentication, real message/SSE completion, duplicate-send idempotency, pagination, stop, and cross-user isolation. The `--write-context <marker>` and `--recall-context <marker>` modes support a deterministic continuity check across a manual Hermes restart; `--leave-running <prompt>` supports the Apt Server restart/no-replay probe.
