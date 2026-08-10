# Contributing

Weixin AgentOS is a local-first, read-only personal project. Changes must preserve its privacy and safety boundaries.

## Development workflow

1. Create a focused branch from `main`.
2. Install dependencies with `npm ci`.
3. Copy `.env.example` to `.env` only when local integration is needed. Never commit `.env`.
4. Keep changes small and add regression tests for behavior or parsing changes.
5. Run `npm run check` before opening a pull request.

Use [Conventional Commits](https://www.conventionalcommits.org/) for commit subjects, for example:

```text
feat(messages): load current-chat updates without changing selection
fix(contacts): hydrate session names from full contact metadata
docs(readme): clarify local snapshot setup
```

## Safety requirements

- Never write to the original WeChat data tree.
- Open SQLite files with `readOnly: true` and execute `PRAGMA query_only=ON`.
- Do not add automatic message sending, read-state writes, UI automation, or background memory scanning.
- Keep the API on `127.0.0.1`; do not widen CORS or bind to all interfaces.
- Use generated fixtures and temporary databases in tests. Never copy real contacts, chats, avatars, media, paths, keys, or exports into fixtures.

See [SECURITY.md](SECURITY.md) before handling credentials or local data paths.
