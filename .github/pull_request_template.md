## Summary

- What changed:
- Why it changed:

## Validation

- [ ] `npm run check` passes
- [ ] No `.env`, API key, database key, chat export, media, log, or local snapshot is included
- [ ] SQLite access remains read-only and uses `PRAGMA query_only=ON`
- [ ] The local API still binds only to `127.0.0.1`
- [ ] README or tests were updated when behavior changed
