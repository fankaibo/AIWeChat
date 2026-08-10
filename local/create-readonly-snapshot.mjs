import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fchmodSync,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createDecipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

const PAGE_SIZE = 4096;
const RESERVE_SIZE = 80;
const SALT_SIZE = 16;
const HMAC_SIZE = 64;
const IV_OFFSET = PAGE_SIZE - RESERVE_SIZE;
const SQLITE_HEADER = Buffer.from("SQLite format 3\u0000", "binary");

process.umask(0o077);

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error(`Invalid argument near ${name ?? "end"}`);
    values.set(name.slice(2), value);
  }
  const source = values.get("source");
  const keys = values.get("keys");
  const destination = values.get("destination");
  if (!source || !keys || !destination) {
    throw new Error("Usage: node local/create-readonly-snapshot.mjs --source DB_ROOT --keys KEYS_JSON --destination SNAPSHOT_ROOT");
  }
  return { source: resolve(source), keys: resolve(keys), destination: resolve(destination), base: values.get("base") ? resolve(values.get("base")) : "" };
}

function isWithin(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function targetedDatabase(relativePath) {
  return relativePath === "contact/contact.db"
    || relativePath === "session/session.db"
    || relativePath === "message/message_resource.db"
    || /^message\/media_\d+\.db$/.test(relativePath)
    || /^message\/(?:biz_)?message_\d+\.db$/.test(relativePath);
}

function collectDatabasePaths(root, hints = []) {
  const paths = [];
  if (hints.length) {
    for (const relativePath of [...new Set(hints)].sort()) {
      if (!targetedDatabase(relativePath)) continue;
      const absolutePath = join(root, relativePath);
      if (existsSync(absolutePath) && statSync(absolutePath).isFile()) paths.push({ absolutePath, relativePath });
    }
    return paths;
  }
  for (const directoryName of ["contact", "session", "message"]) {
    const directory = join(root, directoryName);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) continue;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const absolutePath = join(directory, entry.name);
      const relativePath = relative(root, absolutePath);
      if (targetedDatabase(relativePath)) paths.push({ absolutePath, relativePath });
    }
  }
  return paths.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function fileSignature(path) {
  if (!existsSync(path)) return "missing";
  const stat = statSync(path, { bigint: true });
  return `${stat.size}:${stat.mtimeNs}`;
}

function databaseFileSignature(path) {
  return `${fileSignature(path)}|wal=${fileSignature(`${path}-wal`)}`;
}

function sourceDatabaseSignatures(root, hints = []) {
  return Object.fromEntries(collectDatabasePaths(root, hints).map((database) => [
    database.relativePath,
    databaseFileSignature(database.absolutePath),
  ]));
}

function captureEncryptedDatabase(database, pending) {
  const capturedPath = join(pending, ".encrypted", database.relativePath);
  mkdirSync(dirname(capturedPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    rmSync(capturedPath, { force: true });
    rmSync(`${capturedPath}-wal`, { force: true });
    const before = databaseFileSignature(database.absolutePath);
    try {
      copyFileSync(database.absolutePath, capturedPath, constants.COPYFILE_FICLONE);
      if (existsSync(`${database.absolutePath}-wal`)) copyFileSync(`${database.absolutePath}-wal`, `${capturedPath}-wal`, constants.COPYFILE_FICLONE);
    } catch {
      continue;
    }
    const after = databaseFileSignature(database.absolutePath);
    if (before === after) return { absolutePath: capturedPath, relativePath: database.relativePath, signature: before };
  }
  throw new Error(`Database kept changing while capturing ${database.relativePath}`);
}

function reusableDatabasePaths(databases, base, sourceSignatures) {
  if (!base || !existsSync(base) || !statSync(base).isDirectory()) return new Set();
  let manifest;
  try { manifest = JSON.parse(readFileSync(join(base, "snapshot.json"), "utf8")); }
  catch { return new Set(); }
  if (!manifest?.sourceSignatures || typeof manifest.sourceSignatures !== "object") return new Set();
  return new Set(databases.filter((database) => {
    const basePath = join(base, database.relativePath);
    return manifest.sourceSignatures[database.relativePath] === sourceSignatures[database.relativePath]
      && existsSync(basePath)
      && statSync(basePath).isFile();
  }).map((database) => database.relativePath));
}

function keyDatabaseHints(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const entries = parsed?.keys && typeof parsed.keys === "object" ? parsed.keys : parsed;
  return Object.keys(entries || {}).filter(targetedDatabase);
}

function loadKeys(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  const entries = parsed?.keys && typeof parsed.keys === "object" ? parsed.keys : parsed;
  const unique = new Map();
  for (const value of Object.values(entries)) {
    const encoded = typeof value === "string" ? value : value?.enc_key;
    if (typeof encoded !== "string" || !/^[0-9a-fA-F]{64}$/.test(encoded)) continue;
    unique.set(encoded.toLowerCase(), Buffer.from(encoded, "hex"));
  }
  if (!unique.size) throw new Error("No valid 32-byte database keys were found");
  return [...unique.values()];
}

function decryptBlock(key, iv, encrypted) {
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

function aesHeaderMatches(key, page) {
  if (page.length !== PAGE_SIZE) return false;
  const plaintext = decryptBlock(key, page.subarray(IV_OFFSET, IV_OFFSET + 16), page.subarray(16, 32));
  return plaintext[0] === 0x10
    && plaintext[1] === 0x00
    && (plaintext[2] === 1 || plaintext[2] === 2)
    && (plaintext[3] === 1 || plaintext[3] === 2)
    && plaintext[4] === RESERVE_SIZE
    && plaintext[5] === 64
    && plaintext[6] === 32
    && plaintext[7] === 32;
}

function hmacMatches(key, page) {
  const macSalt = Buffer.from(page.subarray(0, SALT_SIZE)).map((value) => value ^ 0x3a);
  const macKey = pbkdf2Sync(key, macSalt, 2, 32, "sha512");
  const authenticated = page.subarray(SALT_SIZE, PAGE_SIZE - RESERVE_SIZE + SALT_SIZE);
  const pageNumber = Buffer.from([1, 0, 0, 0]);
  const expected = createHmac("sha512", macKey).update(authenticated).update(pageNumber).digest();
  return timingSafeEqual(expected, page.subarray(PAGE_SIZE - HMAC_SIZE));
}

function decryptPage(key, page, pageNumber) {
  if (page.length !== PAGE_SIZE) throw new Error(`Short encrypted page ${pageNumber}`);
  const start = pageNumber === 1 ? SALT_SIZE : 0;
  const encryptedEnd = PAGE_SIZE - RESERVE_SIZE;
  const plaintext = decryptBlock(
    key,
    page.subarray(IV_OFFSET, IV_OFFSET + 16),
    page.subarray(start, encryptedEnd),
  );
  const output = Buffer.alloc(PAGE_SIZE);
  if (pageNumber === 1) SQLITE_HEADER.copy(output, 0);
  plaintext.copy(output, start);
  return output;
}

function decryptMainDatabase(sourcePath, destinationPath, key) {
  const sourceDescriptor = openSync(sourcePath, "r");
  const destinationDescriptor = openSync(destinationPath, "wx", 0o600);
  try {
    fchmodSync(destinationDescriptor, 0o600);
    const size = fstatSync(sourceDescriptor).size;
    if (size < PAGE_SIZE || size % PAGE_SIZE !== 0) throw new Error(`Invalid encrypted database size for ${basename(sourcePath)}`);
    const page = Buffer.alloc(PAGE_SIZE);
    for (let offset = 0, pageNumber = 1; offset < size; offset += PAGE_SIZE, pageNumber += 1) {
      const bytes = readSync(sourceDescriptor, page, 0, PAGE_SIZE, offset);
      if (bytes !== PAGE_SIZE) throw new Error(`Short database read for ${basename(sourcePath)}`);
      const decrypted = decryptPage(key, page, pageNumber);
      writeSync(destinationDescriptor, decrypted, 0, PAGE_SIZE, offset);
    }
  } finally {
    closeSync(sourceDescriptor);
    closeSync(destinationDescriptor);
  }
}

function committedWalFrames(wal) {
  if (wal.length < 32) return null;
  const magic = wal.readUInt32BE(0);
  if (magic !== 0x377f0682 && magic !== 0x377f0683) throw new Error("Unsupported WAL magic");
  const pageSize = wal.readUInt32BE(8) || 1024;
  if (pageSize !== PAGE_SIZE) throw new Error(`Unsupported WAL page size ${pageSize}`);
  const frameSize = 24 + pageSize;
  const frames = [];
  let lastCommit = -1;
  for (let offset = 32; offset + frameSize <= wal.length; offset += frameSize) {
    if (wal.readUInt32BE(offset + 8) !== wal.readUInt32BE(16)
        || wal.readUInt32BE(offset + 12) !== wal.readUInt32BE(20)) break;
    const frame = {
      pageNumber: wal.readUInt32BE(offset),
      databasePages: wal.readUInt32BE(offset + 4),
      page: wal.subarray(offset + 24, offset + frameSize),
    };
    frames.push(frame);
    if (frame.databasePages > 0) lastCommit = frames.length - 1;
  }
  if (lastCommit < 0) return null;
  return { frames: frames.slice(0, lastCommit + 1), databasePages: frames[lastCommit].databasePages };
}

function applyWal(sourcePath, destinationPath, key) {
  const walPath = `${sourcePath}-wal`;
  if (!existsSync(walPath)) return 0;
  const committed = committedWalFrames(readFileSync(walPath));
  if (!committed) return 0;
  const descriptor = openSync(destinationPath, "r+");
  try {
    for (const frame of committed.frames) {
      if (frame.pageNumber < 1) throw new Error("Invalid WAL page number");
      const decrypted = decryptPage(key, frame.page, frame.pageNumber);
      writeSync(descriptor, decrypted, 0, PAGE_SIZE, (frame.pageNumber - 1) * PAGE_SIZE);
    }
  } finally {
    closeSync(descriptor);
  }
  truncateSync(destinationPath, committed.databasePages * PAGE_SIZE);
  return committed.frames.length;
}

function selectKey(keys, firstPage) {
  const direct = keys.filter((key) => aesHeaderMatches(key, firstPage));
  if (direct.length !== 1) return null;
  return { key: direct[0], hmacVerified: hmacMatches(direct[0], firstPage) };
}

export function createReadonlySnapshot(options) {
  if (!existsSync(options.source) || !statSync(options.source).isDirectory()) throw new Error("Source database root does not exist");
  if (!existsSync(options.keys) || !statSync(options.keys).isFile()) throw new Error("Key file does not exist");
  if (existsSync(options.destination)) throw new Error("Destination already exists; refusing to overwrite it");

  const parent = dirname(options.destination);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  if (!isWithin(parent, options.destination)) throw new Error("Invalid destination path");
  const pending = join(parent, `.${basename(options.destination)}.pending-${process.pid}`);
  if (existsSync(pending)) throw new Error("Pending destination already exists");
  mkdirSync(pending, { mode: 0o700 });

  const keys = loadKeys(options.keys);
  const hints = keyDatabaseHints(options.keys);
  const databases = collectDatabasePaths(options.source, hints);
  const sourceSignatures = sourceDatabaseSignatures(options.source, hints);
  const capturedSignatures = { ...sourceSignatures };
  const reusable = reusableDatabasePaths(databases, options.base, sourceSignatures);
  const result = { databases: 0, decryptedDatabases: 0, reusedDatabases: 0, copiedDatabases: 0, walFrames: 0, hmacVerified: 0, unmatched: 0, changedDatabases: [] };
  for (const database of databases) {
    const outputPath = join(pending, database.relativePath);
    mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(outputPath), 0o700);
    if (reusable.has(database.relativePath)) {
      try { linkSync(join(options.base, database.relativePath), outputPath); }
      catch {
        copyFileSync(join(options.base, database.relativePath), outputPath);
        result.copiedDatabases += 1;
        result.changedDatabases.push(database.relativePath);
      }
      chmodSync(outputPath, 0o600);
      result.databases += 1;
      result.reusedDatabases += 1;
      continue;
    }
    const captured = captureEncryptedDatabase(database, pending);
    capturedSignatures[database.relativePath] = captured.signature;
    const descriptor = openSync(captured.absolutePath, "r");
    const firstPage = Buffer.alloc(PAGE_SIZE);
    try {
      if (readSync(descriptor, firstPage, 0, PAGE_SIZE, 0) !== PAGE_SIZE) throw new Error(`Short first page for ${database.relativePath}`);
    } finally {
      closeSync(descriptor);
    }
    const selected = selectKey(keys, firstPage);
    if (!selected) {
      result.unmatched += 1;
      continue;
    }
    decryptMainDatabase(captured.absolutePath, outputPath, selected.key);
    result.walFrames += applyWal(captured.absolutePath, outputPath, selected.key);
    result.databases += 1;
    result.decryptedDatabases += 1;
    result.changedDatabases.push(database.relativePath);
    result.hmacVerified += selected.hmacVerified ? 1 : 0;
  }

  if (result.unmatched > 0 || result.databases !== databases.length) {
    throw new Error(`${result.unmatched || databases.length - result.databases} database key(s) did not match; refusing to publish a partial snapshot`);
  }
  rmSync(join(pending, ".encrypted"), { recursive: true, force: true });

  const corePaths = ["contact/contact.db", "session/session.db"];
  for (const corePath of corePaths) {
    if (!existsSync(join(pending, corePath))) throw new Error(`Core database was not decrypted: ${corePath}`);
  }
  if (!existsSync(join(pending, "message")) || !readdirSync(join(pending, "message")).some((name) => /^(?:biz_)?message_\d+\.db$/.test(name))) {
    throw new Error("No message database was decrypted");
  }
  renameSync(pending, options.destination);
  return { ok: true, ...result, sourceSignatures: capturedSignatures };
}

function main() {
  const options = parseArguments(process.argv.slice(2));
  console.log(JSON.stringify(createReadonlySnapshot(options)));
}

const direct = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Unknown error" }));
    process.exitCode = 1;
  }
}

export { collectDatabasePaths, keyDatabaseHints, reusableDatabasePaths, sourceDatabaseSignatures, targetedDatabase };
