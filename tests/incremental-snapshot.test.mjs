import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectDatabasePaths, reusableDatabasePaths, sourceDatabaseSignatures } from "../local/create-readonly-snapshot.mjs";

test("incremental snapshots reuse only databases whose main file and WAL are unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "weixin-agentos-incremental-"));
  const source = join(root, "source");
  const base = join(root, "base");
  try {
    for (const directory of [join(source, "contact"), join(source, "session"), join(source, "message"), join(base, "contact"), join(base, "session"), join(base, "message")]) mkdirSync(directory, { recursive: true });
    for (const relativePath of ["contact/contact.db", "session/session.db", "message/message_0.db"]) {
      writeFileSync(join(source, relativePath), `encrypted:${relativePath}`);
      writeFileSync(join(base, relativePath), `decrypted:${relativePath}`);
    }
    const databases = collectDatabasePaths(source);
    const initial = sourceDatabaseSignatures(source);
    writeFileSync(join(base, "snapshot.json"), JSON.stringify({ sourceSignatures: initial }));
    assert.deepEqual([...reusableDatabasePaths(databases, base, initial)].sort(), ["contact/contact.db", "message/message_0.db", "session/session.db"]);

    writeFileSync(join(source, "message/message_0.db-wal"), "new committed WAL frame");
    const changed = sourceDatabaseSignatures(source);
    assert.deepEqual([...reusableDatabasePaths(databases, base, changed)].sort(), ["contact/contact.db", "session/session.db"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
