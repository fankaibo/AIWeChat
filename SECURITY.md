# Security and privacy

Weixin AgentOS processes highly sensitive local data. Its primary security boundary is local-only, read-only operation.

## Never commit

- `.env` or any API credential file
- WeChat database keys
- encrypted or decrypted WeChat databases and WAL files
- chat exports, LLM history, logs, transcripts, avatars, images, videos, or audio
- machine-specific absolute paths or launchd configuration

The repository ignores these artifacts by default. Before every commit, review the staged file list and run a secret scan.

## Runtime boundaries

- The API must bind to `127.0.0.1` only.
- Original WeChat files are immutable inputs.
- SQLite connections must be read-only and set `PRAGMA query_only=ON`.
- LLM requests are user-initiated; Responses API requests use `store: false`.
- The project must not send WeChat messages, change read state, modify contacts, or automate the WeChat UI.

## Reporting a problem

Because this is a private repository, report security issues directly to the repository owner. Do not include real secrets, chat content, database files, or screenshots in an issue.

If a secret is committed, revoke or rotate it first, then remove it from Git history. Deleting it only from the latest commit is insufficient.
