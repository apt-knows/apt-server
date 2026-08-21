# Hermes Phase 0 capability result

Tested release: `v2026.8.19` / Hermes Agent `0.20.5`.

The shared multiplex listener was rejected for Apt’s beta. API-server bearer keys, session stores, and profile SQLite databases were isolated, but live custom-provider requests for profile B used profile A’s `MOCK_PROVIDER_KEY`. This crosses a required provider-credential boundary even though transcript rows remained profile-scoped.

The required fallback—one Hermes process/container per profile—passed:

- sequential and concurrent turns with intentionally identical session UUIDs;
- distinct provider credentials and no cross-profile prompt context;
- separate session APIs, histories, and `state.db` files;
- clean restart with isolation retained;
- wrong-key and cross-profile-key denial;
- 81 bundled skills retained in each fresh profile;
- no model tools or MCP servers exposed to the API-server surface;
- run stop settling as cancelled.

Therefore production must set `HERMES_TOPOLOGY=per_profile`. Re-run `npm run test:hermes-capability` before any Hermes upgrade or topology change. The JSON result is the machine-readable audit artifact; the test harness uses no production model credentials or user data.

The local Python runtime emitted Hermes’ SQLite `3.51.2` WAL-reset warning and correctly fell back to `journal_mode=DELETE`. The pinned container uses Python `3.12`; operators should still re-run `hermes doctor` when the upstream image/runtime is refreshed.
