import { createDecipheriv, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const V1_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07]);
const V2_MAGIC = Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]);
const V1_KEY = "cfcd208495d565ef";
const MAX_IMAGE_BYTES = 40 * 1024 * 1024;

function imageFormat(bytes) {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { format: "jpg", contentType: "image/jpeg" };
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return { format: "png", contentType: "image/png" };
  if (bytes.subarray(0, 3).toString("ascii") === "GIF") return { format: "gif", contentType: "image/gif" };
  if (bytes.subarray(0, 2).toString("ascii") === "BM") return { format: "bmp", contentType: "image/bmp" };
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return { format: "webp", contentType: "image/webp" };
  if (bytes.subarray(0, 4).toString("ascii") === "wxgf") return { format: "hevc", contentType: "application/octet-stream" };
  return null;
}

export function imageContentType(bytes) {
  return imageFormat(Buffer.from(bytes || []))?.contentType || "application/octet-stream";
}

export function wxgfLargestPartition(value) {
  const data = Buffer.from(value || []);
  if (data.length < 15 || data.subarray(0, 4).toString("ascii") !== "wxgf") throw new Error("invalid WXGF image");
  const headerLength = Number(data[4]);
  if (headerLength >= data.length) throw new Error("invalid WXGF header");
  for (const pattern of [Buffer.from([0x00, 0x00, 0x00, 0x01]), Buffer.from([0x00, 0x00, 0x01])]) {
    const partitions = [];
    let cursor = headerLength;
    while (cursor < data.length) {
      const index = data.indexOf(pattern, cursor);
      if (index < 0) break;
      if (index >= 4) {
        const size = data.readUInt32BE(index - 4);
        if (size > 0 && index + size <= data.length) {
          partitions.push(data.subarray(index, index + size));
          cursor = index + size;
          continue;
        }
      }
      cursor = index + 1;
    }
    if (partitions.length) return partitions.reduce((largest, item) => item.length > largest.length ? item : largest);
  }
  throw new Error("WXGF HEVC partition was not found");
}

export function convertWxgfToJpeg(value, ffmpegPath = process.env.WEIXIN_FFMPEG_PATH || "ffmpeg") {
  const hevc = wxgfLargestPartition(value);
  const converted = spawnSync(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-f", "hevc", "-i", "pipe:0",
    "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "2", "-f", "image2pipe", "pipe:1",
  ], { input: hevc, encoding: "buffer", timeout: 5_000, maxBuffer: MAX_IMAGE_BYTES });
  if (converted.error || converted.status !== 0 || !converted.stdout?.length) throw new Error("WXGF image conversion failed");
  const bytes = Buffer.from(converted.stdout);
  const format = imageFormat(bytes);
  if (format?.format !== "jpg") throw new Error("WXGF conversion did not return a JPEG image");
  return { bytes, ...format };
}

function decryptEcb(ciphertext, key) {
  const decipher = createDecipheriv("aes-128-ecb", Buffer.from(key, "ascii"), null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function decryptEcbBlock(ciphertext, key) {
  const decipher = createDecipheriv("aes-128-ecb", Buffer.from(key, "ascii"), null);
  decipher.setAutoPadding(false);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function decodeAesXor(data, aesKey, xorKey) {
  if (data.length < 31) throw new Error("image container is truncated");
  const aesSize = data.readUInt32LE(6);
  const xorSize = data.readUInt32LE(10);
  const alignedAesSize = aesSize + (16 - (aesSize % 16));
  const aesStart = 15;
  const aesEnd = aesStart + alignedAesSize;
  const xorStart = data.length - xorSize;
  if (aesSize > MAX_IMAGE_BYTES || xorSize > MAX_IMAGE_BYTES || aesEnd > xorStart || xorStart < 0) throw new Error("invalid image container sizes");
  const aes = decryptEcb(data.subarray(aesStart, aesEnd), aesKey);
  const raw = data.subarray(aesEnd, xorStart);
  const xor = Buffer.from(data.subarray(xorStart));
  for (let index = 0; index < xor.length; index += 1) xor[index] ^= xorKey;
  const output = Buffer.concat([aes, raw, xor]);
  if (!imageFormat(output)) throw new Error("decrypted image format is not recognized");
  return output;
}

function decodeLegacyXor(data) {
  const magics = [
    Buffer.from([0xff, 0xd8, 0xff]),
    Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    Buffer.from("GIF", "ascii"),
    Buffer.from("RIFF", "ascii"),
    Buffer.from("BM", "ascii"),
  ];
  for (const magic of magics) {
    const key = data[0] ^ magic[0];
    if ([...magic].every((value, index) => (data[index] ^ key) === value)) {
      const output = Buffer.from(data);
      for (let index = 0; index < output.length; index += 1) output[index] ^= key;
      if (imageFormat(output)) return output;
    }
  }
  throw new Error("legacy image XOR key was not detected");
}

function normalizeAccountId(value) {
  const id = String(value || "").trim();
  if (/^wxid_/i.test(id)) return id.match(/^(wxid_[^_]+)/i)?.[1] || id;
  return id.replace(/_[a-z0-9]{4}$/i, "");
}

function kvcommDirectories(accountRoot) {
  const marker = `${join("xwechat_files", basename(accountRoot))}`;
  const index = accountRoot.lastIndexOf(marker);
  if (index < 0) return [];
  const documentsRoot = accountRoot.slice(0, index).replace(/\/$/, "");
  return [join(documentsRoot, "app_data", "net", "kvcomm"), join(documentsRoot, "app_data", "ilink", "kvcomm")];
}

function uinCandidates(accountRoot) {
  const values = new Set();
  for (const directory of kvcommDirectories(accountRoot)) {
    if (!existsSync(directory)) continue;
    for (const name of readdirSync(directory)) {
      const match = name.match(/^key_(\d+)_.*\.statistic$/i);
      if (match) values.add(match[1]);
    }
  }
  return [...values];
}

function candidateImageKeys(accountRoot, data) {
  const account = basename(accountRoot);
  const ids = [...new Set([normalizeAccountId(account), account])];
  const ciphertext = data.subarray(15, 31);
  for (const uin of uinCandidates(accountRoot)) {
    for (const id of ids) {
      const aesKey = createHash("md5").update(`${uin}${id}`).digest("hex").slice(0, 16);
      try {
        if (imageFormat(decryptEcbBlock(ciphertext, aesKey))) return { aesKey, xorKey: Number(BigInt(uin) & 0xffn) };
      } catch {}
    }
  }
  return null;
}

export function resourceToken(packedInfo) {
  if (!packedInfo) return "";
  const matches = Buffer.from(packedInfo).toString("latin1").match(/[a-fA-F0-9]{32}/g) || [];
  return matches[0]?.toLowerCase() || "";
}

export function decodeWechatImage(path, accountRoot) {
  const data = readFileSync(path);
  if (data.length > MAX_IMAGE_BYTES) throw new Error("image is larger than the local preview limit");
  let output;
  if (data.subarray(0, V2_MAGIC.length).equals(V2_MAGIC)) {
    const keys = candidateImageKeys(accountRoot, data);
    if (!keys) throw new Error("WeChat V2 image key could not be derived from local metadata");
    output = decodeAesXor(data, keys.aesKey, keys.xorKey);
  } else if (data.subarray(0, V1_MAGIC.length).equals(V1_MAGIC)) {
    output = decodeAesXor(data, V1_KEY, 0x88);
  } else if (imageFormat(data)) {
    output = data;
  } else {
    output = decodeLegacyXor(data);
  }
  return { bytes: output, ...imageFormat(output) };
}

export class WechatMediaResolver {
  constructor(accountRoot) {
    this.accountRoot = accountRoot;
    this.cache = new Map();
    this.videoIndexCache = new Map();
  }

  find(username, token, variant = "thumbnail") {
    if (!this.accountRoot || !/^[a-f0-9]{32}$/.test(token)) return "";
    const chatHash = createHash("md5").update(username).digest("hex");
    const root = join(this.accountRoot, "msg", "attach", chatHash);
    if (!existsSync(root)) return "";
    const suffixes = variant === "full" ? [".dat", "_h.dat", "_t.dat"] : ["_t.dat", ".dat", "_h.dat"];
    const months = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    for (const month of months) {
      const directory = join(root, month, "Img");
      if (!existsSync(directory)) continue;
      for (const suffix of suffixes) {
        const path = join(directory, `${token}${suffix}`);
        if (existsSync(path) && statSync(path).isFile()) return path;
      }
    }
    return "";
  }

  image(username, token, variant = "thumbnail") {
    const path = this.find(username, token, variant);
    if (!path) return null;
    const stat = statSync(path);
    const cacheKey = `${path}:${stat.size}:${stat.mtimeMs}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const decoded = decodeWechatImage(path, this.accountRoot);
    const result = { ...decoded, sourceSize: stat.size };
    this.cache.set(cacheKey, result);
    while (this.cache.size > 48) this.cache.delete(this.cache.keys().next().value);
    return result;
  }

  videoMonthIndex(month) {
    const directory = join(this.accountRoot, "msg", "video", month);
    if (!existsSync(directory)) return [];
    const directoryStat = statSync(directory);
    const cached = this.videoIndexCache.get(month);
    if (cached?.mtimeMs === directoryStat.mtimeMs) return cached.items;
    const items = [];
    for (const name of readdirSync(directory)) {
      if (!name.endsWith("_thumb.jpg")) continue;
      const path = join(directory, name);
      try {
        const stat = statSync(path);
        if (stat.isFile()) items.push({ base: name.slice(0, -"_thumb.jpg".length), path, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {}
    }
    this.videoIndexCache.set(month, { mtimeMs: directoryStat.mtimeMs, items });
    while (this.videoIndexCache.size > 8) this.videoIndexCache.delete(this.videoIndexCache.keys().next().value);
    return items;
  }

  video({ createTime = 0, thumbnailBytes = 0 } = {}) {
    const timestamp = Number(createTime || 0);
    if (!this.accountRoot || !Number.isFinite(timestamp) || timestamp <= 0) return null;
    const shanghai = new Date(timestamp + 8 * 60 * 60 * 1000);
    const month = shanghai.getUTCMonth();
    const year = shanghai.getUTCFullYear();
    const months = [-1, 0, 1].map((offset) => {
      const value = new Date(Date.UTC(year, month + offset, 1));
      return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
    });
    const candidates = months.flatMap((value) => this.videoMonthIndex(value));
    if (!candidates.length) return null;
    const expectedSize = Number(thumbnailBytes || 0);
    const sizeMatches = expectedSize > 0 ? candidates.filter((item) => item.size === expectedSize) : [];
    const pool = sizeMatches.length ? sizeMatches : candidates;
    const nearest = pool.reduce((best, item) => Math.abs(item.mtimeMs - timestamp) < Math.abs(best.mtimeMs - timestamp) ? item : best);
    const maximumDelta = sizeMatches.length ? 6 * 60 * 60 * 1000 : 2 * 60 * 1000;
    if (Math.abs(nearest.mtimeMs - timestamp) > maximumDelta) return null;
    const directory = join(this.accountRoot, "msg", "video", months.find((value) => nearest.path.includes(`/video/${value}/`)) || months[1]);
    const videoPath = [`${nearest.base}.mp4`, `${nearest.base}_raw.mp4`].map((name) => join(directory, name)).find((path) => existsSync(path) && statSync(path).isFile()) || "";
    return { posterPath: nearest.path, videoPath, posterBytes: nearest.size, ...(videoPath ? { videoBytes: statSync(videoPath).size } : {}) };
  }
}
