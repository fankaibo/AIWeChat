import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const PAGE_SIZE = 4096;
const IV_OFFSET = 4016;

function argumentsFor(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) values.set(argv[index]?.replace(/^--/, ""), argv[index + 1]);
  const source = values.get("source");
  const output = values.get("output");
  if (!source || !output) throw new Error("Usage: node prepare-key-targets.mjs --source DB_ROOT --output TARGETS_JSON");
  return { source: resolve(source), output: resolve(output) };
}

function target(relativePath) {
  return relativePath === "contact/contact.db"
    || relativePath === "session/session.db"
    || /^message\/(?:biz_)?message_\d+\.db$/.test(relativePath)
    || /^message\/media_\d+\.db$/.test(relativePath)
    || relativePath === "message/message_fts.db"
    || relativePath === "message/message_resource.db";
}

function databases(root) {
  const result = [];
  for (const name of ["contact", "session", "message"]) {
    const directory = join(root, name);
    try {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const path = join(directory, entry.name);
        const relativePath = relative(root, path);
        if (target(relativePath)) result.push({ path, relativePath });
      }
    } catch {}
  }
  return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function addFingerprint(targets, name, database, page, source) {
  if (page.length !== PAGE_SIZE) return;
  const iv = page.subarray(IV_OFFSET, IV_OFFSET + 16).toString("hex");
  const block = page.subarray(16, 32).toString("hex");
  if (Object.values(targets).some((value) => value.database === database && value.iv === iv && value.block === block)) return;
  targets[name] = { database, source, iv, block };
}

function addWalFingerprints(targets, database) {
  const walPath = `${database.path}-wal`;
  if (!existsSync(walPath)) return;
  const wal = readFileSync(walPath);
  if (wal.length < 32) return;
  const pageSize = wal.readUInt32BE(8) || 1024;
  if (pageSize !== PAGE_SIZE) return;
  const frameSize = 24 + pageSize;
  for (let offset = 32, frame = 1; offset + frameSize <= wal.length; offset += frameSize, frame += 1) {
    if (wal.readUInt32BE(offset + 8) !== wal.readUInt32BE(16) || wal.readUInt32BE(offset + 12) !== wal.readUInt32BE(20)) break;
    if (wal.readUInt32BE(offset) !== 1) continue;
    addFingerprint(targets, `${database.relativePath}#wal-${frame}`, database.relativePath, wal.subarray(offset + 24, offset + frameSize), "wal");
  }
}

function main() {
  const options = argumentsFor(process.argv.slice(2));
  if (!statSync(options.source).isDirectory()) throw new Error("database root is not a directory");
  const targets = {};
  for (const database of databases(options.source)) {
    const descriptor = openSync(database.path, "r");
    const page = Buffer.alloc(PAGE_SIZE);
    try {
      if (readSync(descriptor, page, 0, PAGE_SIZE, 0) !== PAGE_SIZE) throw new Error(`short first page: ${database.relativePath}`);
    } finally {
      closeSync(descriptor);
    }
    addFingerprint(targets, `${database.relativePath}#main`, database.relativePath, page, "main");
    addWalFingerprints(targets, database);
  }
  const targetDatabases = new Set(Object.values(targets).map((value) => value.database));
  if (targetDatabases.size < 3) throw new Error("not enough target databases");
  mkdirSync(dirname(options.output), { recursive: true, mode: 0o700 });
  writeFileSync(options.output, `${JSON.stringify({ pageSize: PAGE_SIZE, targets }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(options.output, 0o600);
  console.log(JSON.stringify({ ok: true, databases: targetDatabases.size, fingerprints: Object.keys(targets).length }));
}

try { main(); }
catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "target preparation failed" }));
  process.exitCode = 1;
}
