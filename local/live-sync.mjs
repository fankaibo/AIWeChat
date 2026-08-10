import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { collectDatabasePaths, keyDatabaseHints, sourceDatabaseSignatures } from "./create-readonly-snapshot.mjs";

const source = resolve(process.env.WEIXIN_LIVE_SOURCE || "");
const root = resolve(process.env.WEIXIN_LIVE_ROOT || join(process.cwd(), ".local", "wechat-live"));
const keysPath = resolve(process.env.WEIXIN_LIVE_KEYS || join(root, "keys.json"));
const statusPath = resolve(process.env.WEIXIN_LIVE_STATUS || join(root, "status.json"));
const revisionsDir = join(root, "revisions");
const currentLink = join(root, "current");
const pollMs = Math.max(750, Number(process.env.WEIXIN_LIVE_POLL_MS) || 1500);
const settleMs = Math.max(500, Number(process.env.WEIXIN_LIVE_SETTLE_MS) || 1200);
const retainRevisions = Math.max(2, Number(process.env.WEIXIN_LIVE_RETAIN) || 3);
const retryMs = Math.max(15_000, Number(process.env.WEIXIN_LIVE_RETRY_MS) || 60_000);
const snapshotWorker = fileURLToPath(new URL("./create-readonly-snapshot.mjs", import.meta.url));

process.umask(0o077);

function inside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function ensureDirectories() {
  for (const directory of [root, revisionsDir]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
}

function atomicJson(path, value) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

function sourceState() {
  if (!source || source === "/" || !existsSync(source) || !statSync(source).isDirectory()) {
    return { signature: "unavailable", modifiedAt: 0, databases: 0 };
  }
  let modifiedAt = 0;
  const databases = collectDatabasePaths(source, existsSync(keysPath) ? keyDatabaseHints(keysPath) : []);
  for (const database of databases) {
    for (const path of [database.absolutePath, `${database.absolutePath}-wal`]) {
      if (existsSync(path)) modifiedAt = Math.max(modifiedAt, statSync(path).mtimeMs);
    }
  }
  const signatures = sourceDatabaseSignatures(source, existsSync(keysPath) ? keyDatabaseHints(keysPath) : []);
  return {
    signature: JSON.stringify(signatures),
    signatures,
    modifiedAt,
    databases: databases.length,
  };
}

function validateSnapshot(directory, changedPaths = []) {
  const databases = collectDatabasePaths(directory);
  if (databases.length < 3) throw new Error("snapshot is missing core databases");
  const changed = new Set(changedPaths);
  let checked = 0;
  for (const database of databases) {
    if (!changed.has(database.relativePath)) continue;
    const db = new DatabaseSync(database.absolutePath, { readOnly: true, timeout: 5000 });
    try {
      db.exec("PRAGMA query_only=ON");
      const result = db.prepare("PRAGMA quick_check").all();
      if (!result.length || result.some((row) => Object.values(row)[0] !== "ok")) {
        throw new Error(`SQLite validation failed for ${database.relativePath}`);
      }
      checked += 1;
    } finally {
      db.close();
    }
  }
  return { total: databases.length, checked };
}

function switchCurrent(revision) {
  const temporary = join(root, `.current-${process.pid}`);
  if (existsSync(temporary) || lstatSafe(temporary)) rmSync(temporary, { force: true });
  symlinkSync(join("revisions", revision), temporary, "dir");
  renameSync(temporary, currentLink);
}

function lstatSafe(path) {
  try { return lstatSync(path); } catch { return null; }
}

function restoreCurrentRevision() {
  if (!existsSync(currentLink)) return;
  try {
    currentRevision = basename(realpathSync(currentLink));
    const manifest = JSON.parse(readFileSync(join(currentLink, "snapshot.json"), "utf8"));
    lastSyncAt = Number(manifest.createdAt || 0);
    lastSnapshotMetrics = {
      syncStrategy: String(manifest.syncStrategy || "full"),
      reusedDatabases: Number(manifest.reusedDatabases || 0),
      decryptedDatabases: Number(manifest.decryptedDatabases || manifest.databases || 0),
      checkedDatabases: Number(manifest.checkedDatabases || manifest.validatedDatabases || 0),
      snapshotMs: Number(manifest.snapshotMs || 0),
    };
  } catch {}
}

function cleanupRevisions(currentRevision) {
  const revisions = readdirSync(revisionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const keep = new Set([currentRevision, ...revisions.slice(0, retainRevisions)]);
  for (const revision of revisions) {
    const path = join(revisionsDir, revision);
    if (!keep.has(revision) && inside(revisionsDir, path)) rmSync(path, { recursive: true, force: true });
  }
}

function cleanupPending() {
  for (const entry of readdirSync(revisionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\..+\.pending-\d+$/.test(entry.name)) continue;
    const path = join(revisionsDir, entry.name);
    if (inside(revisionsDir, path)) rmSync(path, { recursive: true, force: true });
  }
}

function createSnapshot(destination, base = "") {
  return new Promise((resolveSnapshot, rejectSnapshot) => {
    const argumentsList = [snapshotWorker, "--source", source, "--keys", keysPath, "--destination", destination];
    if (base) argumentsList.push("--base", base);
    execFile(process.execPath, argumentsList, {
      encoding: "utf8",
      timeout: 25_000,
      killSignal: "SIGKILL",
      maxBuffer: 1_000_000,
    }, (error, stdout) => {
      if (error) return rejectSnapshot(error.killed ? new Error("snapshot source read timed out; previous revision remains active") : error);
      try {
        const result = JSON.parse(String(stdout || "{}").trim());
        if (!result.ok) throw new Error(result.error || "snapshot worker failed");
        resolveSnapshot(result);
      } catch (parseError) {
        rejectSnapshot(parseError);
      }
    });
  });
}

let stopped = false;
let syncing = false;
let observed = sourceState();
let changedAt = Date.now();
let currentRevision = "";
let lastSyncAt = 0;
let lastError = "";
let lastAttemptAt = 0;
let lastSnapshotMetrics = {};

function publish(state, extra = {}) {
  atomicJson(statusPath, {
    mode: "live-readonly",
    state,
    revision: currentRevision,
    lastSyncAt,
    sourceModifiedAt: observed.modifiedAt,
    watchedDatabases: observed.databases,
    pollMs,
    retryMs,
    readonly: true,
    keyStorage: existsSync(keysPath) ? "local-0600" : "missing",
    lastError,
    processId: process.pid,
    ...lastSnapshotMetrics,
    ...extra,
  });
}

async function synchronize() {
  if (syncing || stopped) return;
  if (!existsSync(keysPath)) {
    publish("needs-keys");
    return;
  }
  if (observed.signature === "unavailable" || observed.databases === 0) {
    publish("waiting-for-wechat");
    return;
  }

  syncing = true;
  lastAttemptAt = Date.now();
  lastError = "";
  publish("syncing");
  const snapshotStartedAt = Date.now();
  const revision = `${Date.now()}-${process.pid}`;
  const destination = join(revisionsDir, revision);
  try {
    cleanupPending();
    const base = currentRevision && existsSync(currentLink) ? realpathSync(currentLink) : "";
    const result = await createSnapshot(destination, base);
    const finished = sourceState();
    const validation = validateSnapshot(destination, result.changedDatabases);
    const snapshotMs = Date.now() - snapshotStartedAt;
    const syncStrategy = result.reusedDatabases > 0 ? "incremental" : "full";
    atomicJson(join(destination, "snapshot.json"), {
      revision,
      createdAt: Date.now(),
      sourceModifiedAt: finished.modifiedAt,
      sourceSignatures: result.sourceSignatures,
      databases: result.databases,
      validatedDatabases: validation.total,
      checkedDatabases: validation.checked,
      reusedDatabases: result.reusedDatabases,
      decryptedDatabases: result.decryptedDatabases,
      copiedDatabases: result.copiedDatabases,
      syncStrategy,
      snapshotMs,
      walFrames: result.walFrames,
    });
    switchCurrent(revision);
    currentRevision = revision;
    lastSyncAt = Date.now();
    const capturedSignature = JSON.stringify(result.sourceSignatures || {});
    observed = { ...finished, signature: capturedSignature, signatures: result.sourceSignatures || {} };
    if (capturedSignature !== finished.signature) changedAt = Date.now();
    lastSnapshotMetrics = { syncStrategy, reusedDatabases: result.reusedDatabases, decryptedDatabases: result.decryptedDatabases, checkedDatabases: validation.checked, snapshotMs };
    publish("live", { databases: result.databases, validatedDatabases: validation.total, walFrames: result.walFrames });
    cleanupRevisions(revision);
  } catch (error) {
    if (existsSync(destination) && inside(revisionsDir, destination)) rmSync(destination, { recursive: true, force: true });
    cleanupPending();
    lastError = error instanceof Error ? error.message : "sync failed";
    publish("error");
  } finally {
    syncing = false;
  }
}

async function tick() {
  if (stopped || syncing) return;
  const next = sourceState();
  if (next.signature !== observed.signature) {
    observed = next;
    changedAt = Date.now();
    publish("settling");
    return;
  }
  if (!currentRevision && existsSync(currentLink)) {
    try { currentRevision = basename(realpathSync(currentLink)); } catch {}
  }
  if (Date.now() - lastAttemptAt < retryMs) return;
  if (!currentRevision || (Date.now() - changedAt >= settleMs && next.modifiedAt > lastSyncAt)) await synchronize();
}

function stop() {
  stopped = true;
  try {
    const current = JSON.parse(readFileSync(statusPath, "utf8"));
    if (Number(current.processId) === process.pid) publish("stopped");
  } catch {}
  process.exit(0);
}

ensureDirectories();
restoreCurrentRevision();
publish(existsSync(keysPath) ? "starting" : "needs-keys");
await synchronize();
setInterval(() => { void tick(); }, pollMs);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await new Promise(() => {});
