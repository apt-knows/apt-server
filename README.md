# Apt server

Private messaging backend for Apt’s 10-user beta. The mobile app authenticates with Supabase, this service owns all transcript writes, and each user is mapped to one manually provisioned Hermes profile and stable session.

## Runtime contract

- Node.js `22.22.0`, strict TypeScript, Fastify, PostgreSQL, and Hermes Agent `v2026.8.19` (`0.20.5`).
- Supabase Auth access tokens are required on every `/v1/chat/*` route. A `401` never falls back to an anonymous identity.
- Mobile clients cannot read or write the three chat tables directly. RLS is forced, `anon`/`authenticated` grants are revoked, and only the private server database connection mutates transcripts.
- There is one user-visible thread, one active run per user, and one stable Hermes session per user.
- The selected Hermes topology is `per_profile`; see [the Phase 0 result](docs/hermes-capability.md).
- No outcome classifier, Hunt/Claw orchestration, products, Apt-specific soul, generated skills, or automatic provisioning is part of this service.

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

## API

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/health` | Bounded database and Hermes readiness |
| `GET` | `/v1/chat?before=<sequence>&limit=50` | Read chronological history and the active run |
| `POST` | `/v1/chat/messages` | Idempotently append a user turn, reserve an assistant message, and create a run |
| `GET` | `/v1/chat/runs/:runId` | Read the authenticated user’s run snapshot |
| `GET` | `/v1/chat/runs/:runId/events` | Sanitized SSE: snapshot, assistant delta, and terminal events only |
| `POST` | `/v1/chat/runs/:runId/stop` | Mark stopping and interrupt Hermes when a Hermes run exists |

Message bodies are `{ "clientMessageId": "<uuid>", "content": "..." }`. Content is normalized and limited to 8,000 characters. Reusing the same client message ID for the same user returns the original turn; a second active turn returns `RUN_IN_PROGRESS`.

Stable error response:

```json
{ "error": { "code": "AGENT_NOT_PROVISIONED", "message": "Apt chat has not been provisioned for this user." } }
```

## Database

Migrations live under `supabase/migrations` and are already applied to the `aptknows-auth` project. They define:

- `agent_instances`: Supabase user to opaque Hermes profile/session mapping.
- `messages`: keyset-ordered user and assistant transcript with same-owner reply constraints.
- `agent_runs`: request/response ownership constraints and a partial unique index permitting only one active run per user.

On startup, queued/running/stopping rows are failed with `SERVER_RESTARTED`; Hermes is stopped best-effort and no prompt is replayed.

## Manual beta lifecycle

Provisioning is deliberately operator-only and idempotent. It validates the Supabase user, derives opaque stable identifiers, creates a Hermes profile with bundled skills, disables all model tools and MCP access, writes the provider secret with mode `0600`, validates Hermes config, then upserts the mapping.

```bash
npm run provision-user -- --user-id <supabase-user-uuid>
npm run disable-user -- --user-id <supabase-user-uuid>
npm run delete-user -- --user-id <supabase-user-uuid> --confirm <same-supabase-user-uuid>
```

Deletion removes the Hermes profile before database records. A failure leaves database ownership records intact so an operator can retry safely.

After provisioning, start exactly one pinned Hermes process/container for that profile. Name it `hermes-<opaque-profile-name>` on the backend network so `HERMES_PROFILE_URL_TEMPLATE=http://hermes-{profile}:8642` resolves it. Never expose port `8642` publicly. Repeat the example service in [docker-compose.example.yml](docker-compose.example.yml) once per beta profile; there is no runtime provisioner.

## Verification

```bash
HERMES_CLI=/path/to/hermes HERMES_VERSION=v2026.8.19 npm run test:hermes-capability
```

The harness creates two fresh profiles and a deterministic OpenAI-compatible provider, then verifies sequential/concurrent turns, provider context and credential separation, session/history/state isolation, restart isolation, cross-key denial, bundled skills, zero enabled dangerous tools, and stop behavior. It writes [the audit result](docs/hermes-capability-results.json).
