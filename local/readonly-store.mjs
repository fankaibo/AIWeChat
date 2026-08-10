import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { resourceToken, WechatMediaResolver } from "./wechat-media.mjs";

const MESSAGE_RE = /^(?:biz_)?message_\d+\.db$/;
const MEDIA_RE = /^media_\d+\.db$/;
const FOLDED_GROUP_FLAG = 0x10000000;
const SYSTEM_CONTACTS = new Set([
  "blogapp", "filehelper", "fmessage", "floatbottle", "helper_entry", "masssendapp", "medianote",
  "newsapp", "notifymessage", "qmessage", "qqmail", "tmessage", "weixin",
]);

export function isGroupUsername(username) {
  return /@(?:im\.)?chatroom$/i.test(String(username || ""));
}

export function directoryContactKind(contact = {}) {
  const username = String(contact.username || "");
  const flag = Number(contact.flag || 0);
  const localType = Number(contact.local_type ?? contact.localType ?? 0);
  const verifyFlag = Number(contact.verify_flag ?? contact.verifyFlag ?? 0);
  const deleted = Number(contact.delete_flag ?? contact.deleteFlag ?? 0) !== 0;
  if (!username || deleted || username === "@placeholder_foldgroup") return "";
  if (isGroupUsername(username)) return (flag & 2) !== 0 ? "group" : "";
  if (SYSTEM_CONTACTS.has(username) || username.startsWith("gh_") || verifyFlag !== 0) return "";
  return [1, 5].includes(localType) && (flag & 1) !== 0 ? "contact" : "";
}

export function isFoldedGroupSession(username, contactFlag = 0) {
  const value = String(username || "");
  return value === "@placeholder_foldgroup"
    || (isGroupUsername(value) && (Number(contactFlag || 0) & FOLDED_GROUP_FLAG) !== 0);
}

function safeDb(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
  const db = new DatabaseSync(absolute, { readOnly: true, timeout: 5000 });
  db.exec("PRAGMA query_only=ON");
  return db;
}

function all(statement, ...params) {
  statement.setReadBigInts?.(true);
  return statement.all(...params);
}

function get(statement, ...params) {
  statement.setReadBigInts?.(true);
  return statement.get(...params);
}

function decodeContent(content, compressionType = 0) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Buffer.isBuffer(content) && !(content instanceof Uint8Array)) return String(content);
  const bytes = Buffer.from(content);
  try {
    if (Number(compressionType) === 4) return zstdDecompressSync(bytes).toString("utf8");
    return bytes.toString("utf8");
  } catch {
    return "[无法解压的消息]";
  }
}

function messageKind(localType) {
  const type = Number(BigInt(localType || 0) & 0xffffffffn);
  return ({ 1: "text", 3: "image", 34: "voice", 42: "contact-card", 43: "video", 47: "sticker", 48: "location", 49: "link", 50: "call", 10000: "system", 10002: "system" })[type] || "unknown";
}

export function displayContent(raw, kind) {
  if (!raw) return kind === "text" ? "" : `[${kind}]`;
  if (kind === "text") {
    // Text messages are already separated from the group sender prefix. Keep
    // the user's original line breaks and indentation instead of treating the
    // message like XML and collapsing all whitespace into a single line.
    return String(raw).replace(/\r\n?/g, "\n").replace(/\u0000+$/g, "");
  }
  if (kind === "link" || kind === "file") {
    // Session summaries may contain only the visible app-message title. Preserve
    // that real text instead of inventing a generic link/file label.
    if (!/<appmsg\b/i.test(raw)) return String(raw).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const appMessage = parseAppMessage(raw);
    const title = appMessage?.content || "";
    const appType = Number(appMessage?.appType || 0);
    if (appType === 6) return title ? `[文件] ${title}` : "[文件]";
    if ([33, 36, 44].includes(appType)) return title ? `[小程序] ${title}` : "[小程序]";
    if (appType === 57) return title ? `[引用] ${title}` : "[引用消息]";
    if (appType === 24) return appMessage?.meta?.itemCount ? `[聊天记录] ${appMessage.meta.itemCount} 条内容` : "[聊天记录]";
    return title ? `[链接] ${title}` : "[链接/文件]";
  }
  if (kind === "image") return "图片";
  if (kind === "voice") return "语音消息";
  if (kind === "video") return "视频";
  if (kind === "sticker") return "表情";
  if (kind === "location") return "位置";
  if (kind === "call") return "通话记录";
  return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export function videoMessageMetadata(raw, createTime = 0) {
  const attributes = {};
  const tag = String(raw || "").match(/<videomsg\b([^>]*)>/i)?.[1] || "";
  for (const match of tag.matchAll(/([\w:-]+)=["']([^"']*)["']/g)) attributes[match[1].toLowerCase()] = match[2];
  const number = (name) => Math.max(0, Number(attributes[name] || 0) || 0);
  return {
    createTime: Number(createTime || 0),
    duration: number("playlength"),
    byteLength: number("length"),
    thumbnailBytes: number("cdnthumblength"),
    width: number("cdnthumbwidth"),
    height: number("cdnthumbheight"),
  };
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function xmlElementValue(value, tag) {
  // Match self-closing fields too. Otherwise `<title />` is skipped and a
  // later nested `<title>null</title>` can be mistaken for the card title.
  const match = String(value || "").match(new RegExp(`<${tag}\\b[^>]*?\\/\\s*>|<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}\\s*>`, "i"));
  return decodeXmlText(match?.[1] || "");
}

function appMessageField(value) {
  const text = decodeXmlText(value);
  return /^(?:null|undefined|\(null\))$/i.test(text) ? "" : text;
}

export function parseAppMessage(raw) {
  const value = String(raw || "");
  const appMessage = value.match(/<appmsg\b[^>]*>([\s\S]*?)<\/appmsg>/i)?.[1] || "";
  if (!appMessage) return null;
  const appType = Math.max(0, Number(xmlElementValue(appMessage, "type") || 0));
  if (appType === 57) return null;

  const title = appMessageField(xmlElementValue(appMessage, "title"));
  const description = appMessageField(xmlElementValue(appMessage, "des"));
  const rawUrl = appMessageField(xmlElementValue(appMessage, "url"));
  const rawThumbnailUrl = appMessageField(xmlElementValue(appMessage, "thumburl"));
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : "";
  const thumbnailUrl = /^https?:\/\//i.test(rawThumbnailUrl) ? rawThumbnailUrl : "";
  const recordItem = xmlElementValue(appMessage, "recorditem");
  const itemCount = Math.max(0, Number(recordItem.match(/<datalist\b[^>]*\bcount=["'](\d+)["']/i)?.[1] || 0));
  const cardType = appType === 24 ? "record" : appType === 6 ? "file" : [33, 36, 44].includes(appType) ? "mini-program" : "link";
  const cardTypeLabel = ({ record: "聊天记录", file: "文件", "mini-program": "小程序", link: "链接" })[cardType];
  const fallbackTitle = appType === 24 ? "聊天记录" : appType === 6 ? "文件" : [33, 36, 44].includes(appType) ? "小程序" : "链接消息";
  const content = title || (appType === 24 ? fallbackTitle : description.split("\n").find((line) => line.trim())?.trim()) || fallbackTitle;

  return {
    content,
    appType,
    meta: {
      appType,
      cardType,
      cardTypeLabel,
      ...(description ? { description } : {}),
      ...(url && appType !== 24 ? { url } : {}),
      ...(thumbnailUrl ? { thumbnailUrl } : {}),
      ...(itemCount ? { itemCount } : {}),
    },
  };
}

function replyTypeLabel(kind) {
  return ({ text: "文字", image: "图片", voice: "语音", video: "视频", sticker: "表情", location: "位置", link: "链接", file: "文件", "contact-card": "名片" })[kind] || "消息";
}

function trimReplyContent(value, limit = 1200) {
  const text = String(value || "").replace(/^(?:wxid_[^:\n]+|[^:\n]{1,80}@chatroom):\n/, "").trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function splitMessagePayload(value, isGroup = false) {
  const decoded = String(value || "");
  const marker = isGroup ? decoded.indexOf(":\n") : -1;
  const prefix = marker >= 0 ? decoded.slice(0, marker) : "";
  const hasSenderPrefix = marker > 0 && marker <= 128 && !/[<>\s]/.test(prefix);
  return hasSenderPrefix
    ? { prefixedSender: decoded.slice(0, marker), rawMessage: decoded.slice(marker + 2) }
    : { prefixedSender: "", rawMessage: decoded };
}

export function parseReplyMessage(raw) {
  const value = String(raw || "");
  const appType = Number(value.match(/<appmsg[\s\S]*?<type>(\d+)<\/type>/i)?.[1] || 0);
  if (appType !== 57) return null;
  const reference = value.match(/<refermsg>([\s\S]*?)<\/refermsg>/i)?.[1] || "";
  if (!reference) return null;
  const quotedTypeNumber = Number(xmlElementValue(reference, "type") || 0);
  const quotedKind = messageKind(quotedTypeNumber);
  const quotedRaw = trimReplyContent(xmlElementValue(reference, "content"));
  const quotedSource = xmlElementValue(reference, "msgsource");
  const quotedFilename = xmlElementValue(quotedSource, "img_file_name");
  const quotedText = quotedKind === "text"
    ? quotedRaw
    : quotedKind === "image"
      ? `图片${quotedFilename ? ` · ${quotedFilename}` : ""}`
      : displayContent(quotedRaw, quotedKind);
  const content = xmlElementValue(value, "title") || "回复了一条消息";
  const quotedTimestamp = Math.max(0, Number(xmlElementValue(reference, "createtime") || 0)) * 1000;
  return {
    content,
    meta: {
      quote: quotedText || `${replyTypeLabel(quotedKind)}消息`,
      quoteSender: xmlElementValue(reference, "displayname") || xmlElementValue(reference, "chatusr") || "原消息",
      quoteSenderId: xmlElementValue(reference, "chatusr"),
      quoteType: quotedKind,
      quoteTypeLabel: replyTypeLabel(quotedKind),
      quoteFilename: quotedFilename,
      quoteTimestamp: quotedTimestamp,
      quoteServerId: xmlElementValue(reference, "svrid"),
    },
  };
}

function voiceMetadata(raw) {
  const value = String(raw || "");
  const attribute = (name) => value.match(new RegExp(`\\s${name}=["']([^"']*)["']`, "i"))?.[1] || "";
  const transcriptTags = ["voicetranstext", "voicetrans", "transtext", "transcription", "recognitiontext"];
  let transcript = "";
  for (const tag of transcriptTags) {
    transcript = decodeXmlText(value.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"))?.[1] || attribute(tag));
    if (transcript) break;
  }
  const durationMs = Math.max(0, Number(attribute("voicelength") || attribute("length") || 0));
  const durationSeconds = durationMs ? Math.max(1, Math.ceil(durationMs / 1000)) : 0;
  const duration = durationSeconds ? `${Math.floor(durationSeconds / 60)}:${String(durationSeconds % 60).padStart(2, "0")}` : "";
  return {
    duration,
    durationMs,
    transcript,
    transcriptionStatus: transcript ? "available" : "not-stored",
  };
}

function tableName(username) {
  return `Msg_${createHash("md5").update(username).digest("hex")}`;
}

function avatarFor(name, url = "") {
  const tones = ["apricot", "blue", "green", "purple", "orange", "rose", "teal"];
  const hash = [...name].reduce((sum, char) => sum + char.codePointAt(0), 0);
  return { label: ([...String(name).trim()][0] || "?").toUpperCase(), tone: tones[hash % tones.length], ...(url ? { url } : {}) };
}

function readVarint(bytes, start) {
  let value = 0;
  let shift = 0;
  let offset = start;
  while (offset < bytes.length && shift <= 49) {
    const byte = bytes[offset];
    value += (byte & 0x7f) * (2 ** shift);
    offset += 1;
    if ((byte & 0x80) === 0) return { value, offset };
    shift += 7;
  }
  return null;
}

function protobufFields(value) {
  const bytes = Buffer.from(value || []);
  const fields = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    if (!tag) break;
    offset = tag.offset;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value % 8;
    if (!field) break;
    if (wire === 0) {
      const item = readVarint(bytes, offset);
      if (!item) break;
      fields.push({ field, wire, value: item.value });
      offset = item.offset;
    } else if (wire === 1) {
      if (offset + 8 > bytes.length) break;
      fields.push({ field, wire, value: bytes.subarray(offset, offset + 8) });
      offset += 8;
    } else if (wire === 2) {
      const length = readVarint(bytes, offset);
      if (!length || length.value < 0 || length.offset + length.value > bytes.length) break;
      fields.push({ field, wire, value: bytes.subarray(length.offset, length.offset + length.value) });
      offset = length.offset + length.value;
    } else if (wire === 5) {
      if (offset + 4 > bytes.length) break;
      fields.push({ field, wire, value: bytes.subarray(offset, offset + 4) });
      offset += 4;
    } else break;
  }
  return fields;
}

function roomMemberNames(buffer) {
  const result = new Map();
  for (const field of protobufFields(buffer).filter((item) => item.field === 1 && item.wire === 2)) {
    const nested = protobufFields(field.value);
    const username = nested.find((item) => item.field === 1 && item.wire === 2)?.value?.toString("utf8") || "";
    const displayName = nested.find((item) => item.field === 2 && item.wire === 2)?.value?.toString("utf8") || "";
    if (username && displayName) result.set(username, displayName);
  }
  return result;
}

function groupNameFromMembers(buffer) {
  const names = [...roomMemberNames(buffer).values()].filter(Boolean).slice(0, 4);
  return names.length ? `${names.join("、")}（群聊）` : "";
}

function sessionName(username, contactName) {
  if (contactName && contactName !== username) return contactName;
  if (username === "@placeholder_foldgroup") return "折叠的群聊";
  if (username === "brandsessionholder") return "订阅号消息";
  if (username === "brandservicesessionholder") return "服务号消息";
  return contactName || username;
}

function sessionCategory(username, verifyFlag = 0) {
  if (username === "brandsessionholder" || username === "brandservicesessionholder") return "official";
  if (username.startsWith("gh_") || Number(verifyFlag) !== 0) return "official";
  return "chat";
}

function officialType(username) {
  if (username === "brandsessionholder") return "subscription";
  if (username === "brandservicesessionholder") return "service";
  return "account";
}

function sessionNameFromAccountRoot(root) {
  const account = basename(root);
  if (/^wxid_/i.test(account)) return account.match(/^(wxid_[^_]+)/i)?.[1] || account;
  return account.replace(/_[a-z0-9]{4}$/i, "");
}

export class ReadonlyStore {
  constructor(decryptedDir, { mediaRoot = "" } = {}) {
    this.root = resolve(decryptedDir);
    this.contactPath = join(this.root, "contact", "contact.db");
    this.sessionPath = join(this.root, "session", "session.db");
    this.messageDir = join(this.root, "message");
    this.resourcePath = join(this.messageDir, "message_resource.db");
    this.mediaRoot = mediaRoot ? resolve(mediaRoot) : "";
    this.mediaResolver = this.mediaRoot ? new WechatMediaResolver(this.mediaRoot) : null;
    this.selfUsername = this.mediaRoot ? sessionNameFromAccountRoot(this.mediaRoot) : "";
    this.contactMetadataCache = null;
    this.contactMetadataRevision = "";
    this.contactCache = null;
    this.contactCacheRevision = "";
    this.roomNameCache = new Map();
    this.resourceCache = new Map();
    this.videoCache = new Map();
    this.activityCache = new Map();
  }

  static available(decryptedDir) {
    if (!decryptedDir) return false;
    const root = resolve(decryptedDir);
    return existsSync(join(root, "contact", "contact.db")) && existsSync(join(root, "session", "session.db"));
  }

  revision() {
    try {
      const manifest = JSON.parse(readFileSync(join(this.root, "snapshot.json"), "utf8"));
      return String(manifest.revision || manifest.createdAt || "");
    } catch {
      try { return String(statSync(this.contactPath).mtimeMs); } catch { return ""; }
    }
  }

  contactRevision() {
    try {
      const stat = statSync(this.contactPath, { bigint: true });
      return `${stat.size}:${stat.mtimeNs}`;
    } catch {
      return "";
    }
  }

  contacts() {
    const revision = this.contactRevision();
    if (this.contactCache && this.contactCacheRevision === revision) return this.contactCache;
    this.contactCache = this.contactMetadata().map((contact) => {
      const kind = directoryContactKind(contact);
      return kind ? { ...contact, kind } : null;
    }).filter(Boolean).sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "contact" ? -1 : 1;
      return left.sortKey.localeCompare(right.sortKey, "en", { sensitivity: "base" }) || left.name.localeCompare(right.name, "zh-CN", { sensitivity: "base" });
    }).map((contact) => {
      const result = { ...contact };
      delete result.sortKey;
      delete result.flag;
      delete result.localType;
      delete result.deleteFlag;
      return result;
    });
    this.contactCacheRevision = revision;
    return this.contactCache;
  }

  contactMetadata() {
    const revision = this.contactRevision();
    if (this.contactMetadataCache && this.contactMetadataRevision === revision) return this.contactMetadataCache;
    const db = safeDb(this.contactPath);
    if (!db) return [];
    try {
      let memberCounts = new Map();
      try {
        memberCounts = new Map(all(db.prepare("SELECT c.username, COUNT(cm.member_id) AS member_count FROM contact c LEFT JOIN chatroom_member cm ON cm.room_id = c.id WHERE c.username LIKE '%chatroom' GROUP BY c.id, c.username")).map((row) => [row.username, Number(row.member_count)]));
      } catch {}
      this.contactMetadataCache = all(db.prepare("SELECT c.username, c.nick_name, c.remark, c.remark_quan_pin, c.quan_pin, c.small_head_url, c.big_head_url, c.verify_flag, c.flag, c.local_type, c.delete_flag, cr.ext_buffer AS room_buffer FROM contact c LEFT JOIN chat_room cr ON cr.id = c.id")).map((row) => {
        const username = String(row.username || "");
        if (!username) return null;
        const isGroup = isGroupUsername(username);
        const name = row.remark || row.nick_name || (isGroup ? groupNameFromMembers(row.room_buffer) : "") || username;
        const avatarUrl = row.small_head_url || row.big_head_url || "";
        return { username, name, nickName: row.nick_name || "", remark: row.remark || "", avatar: avatarFor(name, avatarUrl), verifyFlag: Number(row.verify_flag || 0), flag: Number(row.flag || 0), localType: Number(row.local_type || 0), deleteFlag: Number(row.delete_flag || 0), folded: isFoldedGroupSession(username, row.flag), sortKey: row.remark_quan_pin || row.quan_pin || name, ...(isGroup ? { memberCount: memberCounts.get(username) || 0 } : {}) };
      }).filter(Boolean);
      this.contactMetadataRevision = revision;
      return this.contactMetadataCache;
    } finally {
      db.close();
    }
  }

  contactMap() {
    return new Map(this.contactMetadata().map((contact) => [contact.username, contact.name]));
  }

  contactDataMap() {
    return new Map(this.contactMetadata().map((contact) => [contact.username, contact]));
  }

  groupNameMap(username) {
    const cacheKey = `${this.revision()}:${username}`;
    if (this.roomNameCache.has(cacheKey)) return this.roomNameCache.get(cacheKey);
    const db = safeDb(this.contactPath);
    if (!db) return new Map();
    try {
      const row = get(db.prepare("SELECT ext_buffer FROM chat_room WHERE username = ? LIMIT 1"), username);
      const names = roomMemberNames(row?.ext_buffer);
      this.roomNameCache.set(cacheKey, names);
      while (this.roomNameCache.size > 100) this.roomNameCache.delete(this.roomNameCache.keys().next().value);
      return names;
    } catch {
      return new Map();
    } finally {
      db.close();
    }
  }

  contactDetail(username) {
    const db = safeDb(this.contactPath);
    if (!db) return null;
    try {
      const row = get(db.prepare("SELECT username, nick_name, remark, alias, description, small_head_url, big_head_url, verify_flag, local_type FROM contact WHERE username = ? LIMIT 1"), username);
      if (!row) return null;
      const isGroup = isGroupUsername(row.username);
      const name = row.remark || row.nick_name || (isGroup ? "未命名群聊" : row.username);
      const directory = this.contacts().find((contact) => contact.username === row.username);
      return {
        username: row.username,
        name,
        nickName: row.nick_name || "",
        remark: row.remark || "",
        alias: row.alias || "",
        description: row.description || "",
        avatarUrl: row.small_head_url || row.big_head_url || "",
        verifyFlag: Number(row.verify_flag || 0),
        localType: Number(row.local_type || 0),
        avatar: avatarFor(name, row.small_head_url || row.big_head_url || ""),
        kind: isGroup ? "group" : "contact",
        ...(isGroup ? { memberCount: directory?.memberCount || 0 } : {}),
      };
    } catch {
      return null;
    } finally {
      db.close();
    }
  }

  groupMembers(username) {
    const db = safeDb(this.contactPath);
    if (!db) return [];
    try {
      const room = get(db.prepare("SELECT id FROM contact WHERE username = ? LIMIT 1"), username);
      if (!room) return [];
      const rows = all(db.prepare("SELECT c.id AS contact_id, c.username, c.nick_name, c.remark, c.small_head_url, c.big_head_url FROM chatroom_member cm JOIN contact c ON c.id = cm.member_id WHERE cm.room_id = ? ORDER BY COALESCE(NULLIF(c.remark, ''), c.nick_name, c.username)"), room.id);
      let ownerId = null;
      try { ownerId = get(db.prepare("SELECT owner FROM chat_room WHERE id = ? LIMIT 1"), room.id)?.owner ?? null; } catch {}
      const roomNames = this.groupNameMap(username);
      return rows.map((row) => {
        const name = roomNames.get(row.username) || row.remark || row.nick_name || row.username;
        const isOwner = ownerId != null && [row.contact_id, row.username].some((value) => String(value) === String(ownerId));
        return { username: row.username, name, remark: row.remark || "", avatar: avatarFor(name, row.small_head_url || row.big_head_url || ""), role: isOwner ? "owner" : "member" };
      });
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  sessions(limit = 80) {
    const db = safeDb(this.sessionPath);
    if (!db) return [];
    try {
      const contacts = this.contactDataMap();
      let sessionTitles = new Map();
      try { sessionTitles = new Map(all(db.prepare("SELECT username, session_title FROM SessionNoContactInfoTable WHERE COALESCE(session_title, '') <> ''")).map((row) => [row.username, row.session_title])); } catch {}
      const requestedLimit = Math.min(Number(limit) || 80, 2000);
      return all(db.prepare(`SELECT username, unread_count, summary, last_timestamp, last_msg_type FROM SessionTable WHERE last_timestamp > 0 ORDER BY last_timestamp DESC LIMIT 2000`)).filter((row) => {
        const contact = contacts.get(row.username);
        return !isFoldedGroupSession(row.username) && !contact?.folded;
      }).slice(0, requestedLimit).map((row) => {
        const contact = contacts.get(row.username);
        const name = sessionName(row.username, sessionTitles.get(row.username) || contact?.name);
        const isGroup = isGroupUsername(row.username);
        const decodedSummary = decodeContent(row.summary, Buffer.isBuffer(row.summary) ? 4 : 0);
        const { rawMessage: raw } = splitMessagePayload(decodedSummary, isGroup);
        const category = sessionCategory(row.username, contact?.verifyFlag);
        return { username: row.username, name, avatar: contact?.avatar || avatarFor(name), lastMessage: displayContent(raw, messageKind(row.last_msg_type)), timestamp: Number(row.last_timestamp) * 1000, unread: Number(row.unread_count || 0), pinned: false, isGroup, category, ...(category === "official" ? { officialType: officialType(row.username) } : {}), ...(isGroup ? { memberCount: contact?.memberCount || 0 } : {}) };
      });
    } finally {
      db.close();
    }
  }

  chatUsernames({ includeFolded = true } = {}) {
    const db = safeDb(this.sessionPath);
    if (!db) return [];
    try {
      const contacts = new Map(this.contacts().map((contact) => [contact.username, contact]));
      return db.prepare("SELECT username FROM SessionTable WHERE last_timestamp > 0").all()
        .map((row) => String(row.username || ""))
        .filter((username) => {
          const contact = contacts.get(username);
          if (!username || username === "@placeholder_foldgroup") return false;
          if (!includeFolded && contact?.folded) return false;
          return sessionCategory(username, contact?.verifyFlag) === "chat";
        });
    } finally {
      db.close();
    }
  }

  messagePaths() {
    if (!existsSync(this.messageDir)) return [];
    return readdirSync(this.messageDir).filter((name) => MESSAGE_RE.test(name)).sort().map((name) => join(this.messageDir, name));
  }

  mediaPaths() {
    if (!existsSync(this.messageDir)) return [];
    return readdirSync(this.messageDir).filter((name) => MEDIA_RE.test(name)).sort().map((name) => join(this.messageDir, name));
  }

  voiceBlob(username, localId, serverId = "", createTimeMs = 0) {
    const normalizedLocalId = Number(localId);
    const normalizedCreateTime = Math.floor(Number(createTimeMs) / 1000);
    const normalizedServerId = /^-?\d+$/.test(String(serverId || "")) ? BigInt(serverId) : 0n;
    if (!username || !Number.isSafeInteger(normalizedLocalId) || normalizedLocalId < 0) return null;
    for (const path of this.mediaPaths()) {
      const db = safeDb(path);
      if (!db) continue;
      try {
        let row = null;
        if (normalizedServerId !== 0n) {
          row = get(db.prepare("SELECT v.create_time, v.local_id, v.svr_id, v.voice_data, v.data_index FROM VoiceInfo v LEFT JOIN Name2Id n ON n.rowid = v.chat_name_id WHERE n.user_name = ? AND v.svr_id = ? ORDER BY v.create_time DESC LIMIT 1"), username, normalizedServerId);
        }
        if (!row && normalizedCreateTime > 0) {
          row = get(db.prepare("SELECT v.create_time, v.local_id, v.svr_id, v.voice_data, v.data_index FROM VoiceInfo v LEFT JOIN Name2Id n ON n.rowid = v.chat_name_id WHERE n.user_name = ? AND v.local_id = ? AND ABS(v.create_time - ?) <= 5 ORDER BY ABS(v.create_time - ?) LIMIT 1"), username, normalizedLocalId, normalizedCreateTime, normalizedCreateTime);
        }
        if (!row) {
          row = get(db.prepare("SELECT v.create_time, v.local_id, v.svr_id, v.voice_data, v.data_index FROM VoiceInfo v LEFT JOIN Name2Id n ON n.rowid = v.chat_name_id WHERE n.user_name = ? AND v.local_id = ? ORDER BY v.create_time DESC LIMIT 1"), username, normalizedLocalId);
        }
        const data = row?.voice_data ? Buffer.from(row.voice_data) : Buffer.alloc(0);
        if (data.length) return {
          data,
          createTime: Number(row.create_time || 0),
          localId: Number(row.local_id || normalizedLocalId),
          serverId: String(row.svr_id || serverId || ""),
          dataIndex: String(row.data_index || ""),
          source: path,
        };
      } catch {
        continue;
      } finally {
        db.close();
      }
    }
    return null;
  }

  resourceTokens(username) {
    const cacheKey = `${this.revision()}:${username}`;
    if (this.resourceCache.has(cacheKey)) return this.resourceCache.get(cacheKey);
    const db = safeDb(this.resourcePath);
    if (!db) return new Map();
    try {
      const rows = all(db.prepare("SELECT r.message_local_id, r.packed_info FROM MessageResourceInfo r JOIN ChatName2Id c ON c.rowid = r.chat_id WHERE c.user_name = ? AND r.message_local_type = 3 ORDER BY r.message_id"), username);
      const result = new Map(rows.map((row) => [Number(row.message_local_id), resourceToken(row.packed_info)]).filter(([, token]) => token));
      this.resourceCache.set(cacheKey, result);
      while (this.resourceCache.size > 100) this.resourceCache.delete(this.resourceCache.keys().next().value);
      return result;
    } catch {
      return new Map();
    } finally {
      db.close();
    }
  }

  image(username, localId, variant = "thumbnail") {
    if (!this.mediaResolver || !Number.isSafeInteger(Number(localId))) return null;
    const token = this.imageToken(username, localId);
    if (!token) return null;
    return this.mediaResolver.image(username, token, variant);
  }

  imageToken(username, localId) {
    if (!Number.isSafeInteger(Number(localId))) return "";
    return this.resourceTokens(username).get(Number(localId)) || "";
  }

  videoForMessage(username, localId, raw = "", createTime = 0) {
    const cacheKey = `${this.revision()}:${username}:${Number(localId)}`;
    if (this.videoCache.has(cacheKey)) return this.videoCache.get(cacheKey);
    // Keep message-list reads cheap and deterministic. Resolving a WeChat video
    // requires scanning local media folders and is delegated to a bounded child
    // process only when the browser actually requests that video.
    const result = videoMessageMetadata(raw, Number(createTime) * 1000);
    this.videoCache.set(cacheKey, result);
    while (this.videoCache.size > 160) this.videoCache.delete(this.videoCache.keys().next().value);
    return result;
  }

  video(username, localId) {
    const normalizedLocalId = Number(localId);
    if (!this.mediaResolver || !Number.isSafeInteger(normalizedLocalId) || normalizedLocalId < 0) return null;
    const cachedKey = `${this.revision()}:${username}:${normalizedLocalId}`;
    if (this.videoCache.has(cachedKey)) return this.videoCache.get(cachedKey);
    const target = tableName(username);
    for (const path of this.messagePaths()) {
      const db = safeDb(path);
      if (!db) continue;
      try {
        if (!get(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"), target)) continue;
        const row = get(db.prepare(`SELECT local_id, create_time, message_content, WCDB_CT_message_content FROM [${target}] WHERE local_id = ? AND (local_type & 4294967295) = 43 LIMIT 1`), normalizedLocalId);
        if (!row) continue;
        const raw = decodeContent(row.message_content, row.WCDB_CT_message_content);
        return this.videoForMessage(username, normalizedLocalId, raw, Number(row.create_time));
      } catch {
        continue;
      } finally {
        db.close();
      }
    }
    return null;
  }

  messageCount(username) {
    const target = tableName(username);
    let count = 0;
    for (const path of this.messagePaths()) {
      const db = safeDb(path);
      if (!db) continue;
      try {
        const exists = get(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"), target);
        if (!exists) continue;
        count += Number(get(db.prepare(`SELECT COUNT(*) AS count FROM [${target}]`))?.count || 0);
      } finally {
        db.close();
      }
    }
    return count;
  }

  monthlyActivity(month, usernames = []) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
    if (!match) return {};
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    if (year < 2000 || year > 2100 || monthIndex < 0 || monthIndex > 11) return {};

    const selectedUsernames = [...new Set(usernames.map((value) => String(value || "")).filter(Boolean))].sort();
    const selectedTables = new Set(selectedUsernames.map(tableName));
    if (!selectedTables.size) return {};
    const identity = createHash("sha1").update(selectedUsernames.join("\n")).digest("hex");
    const cacheKey = `${this.revision()}:${month}:${identity}`;
    if (this.activityCache.has(cacheKey)) return this.activityCache.get(cacheKey);

    const shanghaiOffsetSeconds = 8 * 60 * 60;
    const start = Math.floor((Date.UTC(year, monthIndex, 1) - shanghaiOffsetSeconds * 1000) / 1000);
    const end = Math.floor((Date.UTC(year, monthIndex + 1, 1) - shanghaiOffsetSeconds * 1000) / 1000);
    const counts = new Map();
    for (const path of this.messagePaths()) {
      const db = safeDb(path);
      if (!db) continue;
      try {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'Msg_%'").all();
        for (const { name } of tables) {
          if (!selectedTables.has(name)) continue;
          const rows = db.prepare(`SELECT CAST((create_time + ${shanghaiOffsetSeconds}) / 86400 AS INTEGER) AS day_key, COUNT(*) AS count FROM [${name}] WHERE create_time >= ? AND create_time < ? GROUP BY day_key`).all(start, end);
          for (const row of rows) {
            const date = new Date(Number(row.day_key) * 86400 * 1000).toISOString().slice(0, 10);
            counts.set(date, (counts.get(date) || 0) + Number(row.count || 0));
          }
        }
      } finally {
        db.close();
      }
    }

    const result = Object.fromEntries(counts);
    this.activityCache.set(cacheKey, result);
    while (this.activityCache.size > 24) this.activityCache.delete(this.activityCache.keys().next().value);
    return result;
  }

  hasMessagesBefore(username, { before = Number.MAX_SAFE_INTEGER, beforeSeq = "" } = {}) {
    const sequence = /^-?\d+$/.test(String(beforeSeq || "")) ? BigInt(beforeSeq) : null;
    if (sequence === null && !Number.isFinite(Number(before))) return false;
    const target = tableName(username);
    for (const path of this.messagePaths()) {
      const db = safeDb(path);
      if (!db) continue;
      try {
        const exists = get(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"), target);
        if (!exists) continue;
        const older = sequence === null
          ? get(db.prepare(`SELECT 1 FROM [${target}] WHERE create_time < ? LIMIT 1`), Math.floor(Number(before) / 1000))
          : get(db.prepare(`SELECT 1 FROM [${target}] WHERE sort_seq < ? LIMIT 1`), sequence);
        if (older) return true;
      } finally {
        db.close();
      }
    }
    return false;
  }

  messages(username, { limit = 80, before = Number.MAX_SAFE_INTEGER, beforeSeq = "", keyword = "" } = {}) {
    const target = tableName(username);
    const sequence = /^-?\d+$/.test(String(beforeSeq || "")) ? BigInt(beforeSeq) : null;
    const contacts = this.contactDataMap();
    const roomNames = isGroupUsername(username) ? this.groupNameMap(username) : new Map();
    const resources = this.resourceTokens(username);
    const mediaRevision = this.revision();
    const collected = [];
    for (const path of this.messagePaths()) {
      const db = safeDb(path);
      if (!db) continue;
      try {
        const exists = get(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"), target);
        if (!exists) continue;
        const rows = sequence === null
          ? all(db.prepare(`SELECT local_id, server_id, local_type, sort_seq, create_time, real_sender_id, message_content, WCDB_CT_message_content FROM [${target}] WHERE create_time < ? ORDER BY sort_seq DESC LIMIT ?`), Math.floor(before / 1000), Math.min(Number(limit) || 80, 500))
          : all(db.prepare(`SELECT local_id, server_id, local_type, sort_seq, create_time, real_sender_id, message_content, WCDB_CT_message_content FROM [${target}] WHERE sort_seq < ? ORDER BY sort_seq DESC LIMIT ?`), sequence, Math.min(Number(limit) || 80, 500));
        let idMap = new Map();
        try { idMap = new Map(all(db.prepare("SELECT rowid, user_name FROM Name2Id")).map((row) => [Number(row.rowid), row.user_name])); } catch {}
        for (const row of rows) {
          const decoded = decodeContent(row.message_content, row.WCDB_CT_message_content);
          // Group messages prefix the payload with `senderId:\n`. Split only at the
          // first delimiter: quoted XML can contain another sender prefix itself.
          const { prefixedSender, rawMessage } = splitMessagePayload(decoded, isGroupUsername(username));
          const senderId = idMap.get(Number(row.real_sender_id)) || prefixedSender || "";
          const baseKind = messageKind(row.local_type);
          const reply = baseKind === "link" ? parseReplyMessage(rawMessage) : null;
          const appMessage = baseKind === "link" && !reply ? parseAppMessage(rawMessage) : null;
          const kind = reply ? "quote" : baseKind;
          const isSystem = kind === "system";
          const contact = contacts.get(senderId);
          const sender = isSystem && !senderId ? "系统" : roomNames.get(senderId) || contact?.name || senderId || "未知成员";
          const content = reply?.content || appMessage?.content || displayContent(rawMessage, kind);
          if (keyword && !`${sender} ${content} ${appMessage?.meta?.description || ""} ${reply?.meta?.quote || ""} ${reply?.meta?.quoteSender || ""}`.toLowerCase().includes(keyword.toLowerCase())) continue;
          const localId = Number(row.local_id);
          const token = kind === "image" ? resources.get(localId) : "";
          const video = kind === "video" ? this.videoForMessage(username, localId, rawMessage, Number(row.create_time)) : null;
          const meta = reply?.meta || appMessage?.meta || (token
            ? { mediaUrl: `/media/${encodeURIComponent(username)}/${localId}`, mediaAvailable: true, mediaRevision }
            : kind === "image"
              ? { mediaAvailable: false, mediaRevision }
              : kind === "video"
                ? { localId, createTime: Number(row.create_time) * 1000, duration: video?.duration || 0, size: video?.byteLength || 0, width: video?.width || 0, height: video?.height || 0, posterUrl: `/video/${encodeURIComponent(username)}/${localId}/poster`, videoUrl: `/video/${encodeURIComponent(username)}/${localId}/content`, posterAvailable: Boolean(this.mediaResolver), videoAvailable: Boolean(this.mediaResolver), mediaRevision }
                : kind === "voice"
                  ? { ...voiceMetadata(rawMessage), localId, serverId: String(row.server_id || ""), createTime: Number(row.create_time) * 1000, transcriptionAvailable: this.mediaPaths().length > 0 }
                  : undefined);
          collected.push({ id: `${path}:${row.local_id}`, serverId: String(row.server_id || ""), sortSeq: String(row.sort_seq), sender: senderId === this.selfUsername ? "我" : sender, senderId, avatar: contact?.avatar || avatarFor(sender), timestamp: Number(row.create_time) * 1000, type: kind, content, isMine: Boolean(this.selfUsername && senderId === this.selfUsername), ...(meta ? { meta } : {}), source: path });
        }
      } finally {
        db.close();
      }
    }
    return collected.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
      const left = BigInt(a.sortSeq);
      const right = BigInt(b.sortSeq);
      return left === right ? 0 : left < right ? 1 : -1;
    }).slice(0, Number(limit) || 80).reverse();
  }

  search(query, limit = 60) {
    const results = [];
    for (const session of this.sessions(300)) {
      for (const message of this.messages(session.username, { limit: 300, keyword: query })) {
        results.push({ ...message, chat: session.name, username: session.username });
        if (results.length >= limit) return results.sort((a, b) => b.timestamp - a.timestamp);
      }
    }
    return results.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }
}
