import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { demoContacts, demoMembers, demoSessions, messagesFor } from "./demo-data.mjs";
import { answerQuestion, summarize } from "./agent.mjs";
import { chatWithLlm, LlmRequestError, llmConfig, publicLlmStatus } from "./llm.mjs";
import { LlmHistoryStore } from "./llm-history.mjs";
import { loadModelCatalog } from "./model-catalog.mjs";
import { ReadonlyStore } from "./readonly-store.mjs";
import { imageContentType } from "./wechat-media.mjs";
import { LocalVoiceTranscriber, VoiceTranscriptionError, voiceCacheIdentity } from "./voice-transcriber.mjs";

const host = "127.0.0.1";
const port = Number(process.env.WEIXIN_AGENTOS_PORT || 8787);
const decryptedDir = process.env.WEIXIN_DECRYPTED_DIR || "";
const liveStatusPath = process.env.WEIXIN_LIVE_STATUS || "";
const liveSource = process.env.WEIXIN_LIVE_SOURCE || "";
const mediaRoot = process.env.WEIXIN_MEDIA_ROOT || (liveSource ? dirname(liveSource) : "");
let liveStore = ReadonlyStore.available(decryptedDir) ? new ReadonlyStore(decryptedDir, { mediaRoot }) : null;
const llm = loadModelCatalog(process.env, llmConfig());
const llmHistoryPath = process.env.WEIXIN_LLM_HISTORY_FILE || fileURLToPath(new URL("../.local/llm-history.json", import.meta.url));
const llmHistory = new LlmHistoryStore(llmHistoryPath);
const mediaWorker = fileURLToPath(new URL("./media-worker.mjs", import.meta.url));
const videoWorker = fileURLToPath(new URL("./video-worker.mjs", import.meta.url));
const mediaJobs = new Map();
const videoJobs = new Map();
const voiceTranscriber = new LocalVoiceTranscriber();

const startedAt = Date.now();

function store() {
  if (!liveStore && ReadonlyStore.available(decryptedDir)) liveStore = new ReadonlyStore(decryptedDir, { mediaRoot });
  return liveStore;
}

function source() {
  return store() ? (liveStatusPath ? "local-live" : "local-snapshot") : "demo";
}

function syncStatus() {
  if (!liveStatusPath) {
    const current = store();
    return { mode: current ? "snapshot" : "demo", state: current ? "static" : "disabled", revision: current?.revision() || "", contactRevision: current?.contactRevision() || "", readonly: true, lastSyncAt: 0, lagMs: null, lastError: "" };
  }
  try {
    if (!existsSync(liveStatusPath)) throw new Error("status unavailable");
    const status = JSON.parse(readFileSync(liveStatusPath, "utf8"));
    const lastSyncAt = Number(status.lastSyncAt || 0);
    return {
      mode: status.mode === "live-readonly" ? status.mode : "live-readonly",
      state: String(status.state || "starting"),
      revision: String(status.revision || ""),
      contactRevision: store()?.contactRevision() || "",
      readonly: true,
      lastSyncAt,
      sourceModifiedAt: Number(status.sourceModifiedAt || 0),
      lagMs: lastSyncAt ? Math.max(0, Date.now() - lastSyncAt) : null,
      watchedDatabases: Number(status.watchedDatabases || 0),
      pollMs: Number(status.pollMs || 0),
      lastError: String(status.lastError || ""),
    };
  } catch {
    return { mode: "live-readonly", state: "starting", revision: "", contactRevision: store()?.contactRevision() || "", readonly: true, lastSyncAt: 0, lagMs: null, lastError: "" };
  }
}

function sessions(limit = 80, category = "") {
  const current = store();
  const list = current ? (() => {
    try { return current.sessions(limit); } catch (error) { console.error("sessions", error); return []; }
  })() : demoSessions.slice(0, limit);
  return ["chat", "official"].includes(category) ? list.filter((item) => item.category === category) : list;
}

function contacts() {
  const current = store();
  if (!current) return demoContacts;
  try { return current.contacts(); } catch (error) { console.error("contacts", error); return []; }
}

function contactSnapshot() {
  const current = store();
  if (!current) return { contacts: demoContacts, revision: "demo" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const before = current.contactRevision();
      const list = current.contacts();
      const after = current.contactRevision();
      if (before === after) return { contacts: list, revision: after };
    } catch (error) {
      if (attempt === 1) console.error("contact snapshot", error);
    }
  }
  return { contacts: [], revision: "" };
}

function messages(username, options = {}) {
  const current = store();
  let result;
  if (!current) {
    const before = Number(options.before) || Number.MAX_SAFE_INTEGER;
    const limit = Math.min(Number(options.limit) || 100, 500);
    result = messagesFor(username).filter((message) => message.timestamp < before).slice(-limit);
  } else {
    try { result = current.messages(username, options); } catch (error) { console.error("messages", error); result = []; }
  }
  return result.map((message) => {
    if (message.type !== "voice" || message.meta?.transcript) return message;
    const cached = voiceTranscriber.cached(voiceCacheIdentity(message, username));
    return cached ? { ...message, meta: { ...message.meta, transcript: cached.transcript || "", transcriptionStatus: cached.status, transcriptionEngine: cached.engine, transcriptionModel: cached.model } } : message;
  });
}

function shanghaiMonth(timestamp = Date.now()) {
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

const analysisPeriods = new Set(["day", "week", "month", "quarter", "year"]);

function analysisPeriod(value) {
  const period = String(value || "").toLowerCase();
  return analysisPeriods.has(period) ? period : "all";
}

function analysisPeriodStart(period, timestamp = Date.now()) {
  if (period === "all") return 0;
  const offset = 8 * 60 * 60 * 1000;
  const shanghai = new Date(timestamp + offset);
  const year = shanghai.getUTCFullYear();
  const month = shanghai.getUTCMonth();
  const day = shanghai.getUTCDate();
  if (period === "year") return Date.UTC(year, 0, 1) - offset;
  if (period === "quarter") return Date.UTC(year, Math.floor(month / 3) * 3, 1) - offset;
  if (period === "month") return Date.UTC(year, month, 1) - offset;
  if (period === "week") {
    const mondayOffset = (shanghai.getUTCDay() + 6) % 7;
    return Date.UTC(year, month, day - mondayOffset) - offset;
  }
  return Date.UTC(year, month, day) - offset;
}

function analysisMessages(username, periodValue, limit = 500) {
  const period = analysisPeriod(periodValue);
  const startAt = analysisPeriodStart(period);
  const all = messages(username, { limit });
  return { period, startAt, messages: startAt ? all.filter((message) => Number(message.timestamp) >= startAt) : all };
}

function validMonth(value) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  return year >= 2000 && year <= 2100 && month >= 1 && month <= 12;
}

function heatmapPayload(month, counts, scope, scopeName) {
  const [year, monthNumber] = month.split("-").map(Number);
  const dayCount = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const days = Array.from({ length: dayCount }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, "0")}`;
    return { date, count: Number(counts[date] || 0) };
  });
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const max = days.reduce((value, day) => Math.max(value, day.count), 0);
  const peakDay = max ? days.find((day) => day.count === max) || null : null;
  return { month, scope, scopeName, days, total, max, activeDays: days.filter((day) => day.count > 0).length, peakDay };
}

function demoActivity(month, username = "") {
  const targets = username
    ? [username]
    : demoSessions.filter((session) => session.category === "chat").map((session) => session.username);
  const counts = {};
  for (const target of targets) {
    for (const message of messagesFor(target)) {
      const date = new Date(message.timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
      if (date.startsWith(`${month}-`)) counts[date] = (counts[date] || 0) + 1;
    }
  }
  return counts;
}

function json(response, status, payload, origin = "") {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  if (["http://localhost:3000", "http://127.0.0.1:3000"].includes(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-methods"] = "GET, POST, OPTIONS";
    headers["access-control-allow-headers"] = "content-type, range";
    headers.vary = "Origin";
  }
  response.writeHead(status, headers);
  response.end(JSON.stringify(payload));
}

function binary(response, status, payload, origin = "") {
  const headers = {
    "content-type": payload?.contentType || "application/octet-stream",
    "content-length": String(payload?.bytes?.length || 0),
    "cache-control": "private, max-age=300",
    "content-disposition": "inline",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  if (["http://localhost:3000", "http://127.0.0.1:3000"].includes(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  response.writeHead(status, headers);
  response.end(payload?.bytes || Buffer.alloc(0));
}

function localFile(request, response, path, contentType, origin = "") {
  if (!path || !existsSync(path)) return false;
  const stat = statSync(path);
  if (!stat.isFile()) return false;
  const headers = {
    "content-type": contentType,
    "cache-control": "private, max-age=300",
    "content-disposition": "inline",
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
  if (["http://localhost:3000", "http://127.0.0.1:3000"].includes(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  const range = String(request.headers.range || "");
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { ...headers, "content-range": `bytes */${stat.size}` });
      response.end();
      return true;
    }
    if (match[1]) start = Number(match[1]);
    if (match[2]) end = Number(match[2]);
    if (!match[1] && match[2]) start = Math.max(0, stat.size - Number(match[2]));
    end = Math.min(end, stat.size - 1);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stat.size) {
      response.writeHead(416, { ...headers, "content-range": `bytes */${stat.size}` });
      response.end();
      return true;
    }
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers["content-length"] = String(end - start + 1);
  response.writeHead(status, headers);
  if (request.method === "HEAD") response.end();
  else createReadStream(path, { start, end }).on("error", () => response.destroy()).pipe(response);
  return true;
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 256_000) {
        reject(new Error("request too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolveBody(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new Error("invalid json")); }
    });
    request.on("error", reject);
  });
}

function sessionByUsername(username) {
  return sessions().find((item) => item.username === username) || { username, name: username };
}

function decodeMedia(username, token, variant) {
  const key = `${username}:${token}:${variant}`;
  if (mediaJobs.has(key)) return mediaJobs.get(key);
  const job = new Promise((resolveJob) => {
    execFile(process.execPath, [mediaWorker, mediaRoot, username, token, variant], {
      encoding: "buffer",
      timeout: 6_000,
      killSignal: "SIGKILL",
      maxBuffer: 42 * 1024 * 1024,
    }, (error, stdout) => {
      if (error || !stdout?.length) return resolveJob(null);
      const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
      resolveJob({ bytes, contentType: imageContentType(bytes) });
    });
  });
  mediaJobs.set(key, job);
  void job.then((result) => {
    if (!result) setTimeout(() => { if (mediaJobs.get(key) === job) mediaJobs.delete(key); }, 15_000).unref();
    while (mediaJobs.size > 64) mediaJobs.delete(mediaJobs.keys().next().value);
  });
  return job;
}

function safeMediaPath(value) {
  if (!value || !mediaRoot) return "";
  const root = resolve(mediaRoot);
  const path = resolve(String(value));
  return path.startsWith(`${root}${sep}`) ? path : "";
}

function resolveVideo(username, localId) {
  const key = `${username}:${localId}`;
  if (videoJobs.has(key)) return videoJobs.get(key);
  const metadata = store()?.video(username, localId) || null;
  if (!metadata?.createTime || !mediaRoot) return Promise.resolve(null);
  const job = new Promise((resolveJob) => {
    execFile(process.execPath, [videoWorker, mediaRoot, String(metadata.createTime), String(metadata.thumbnailBytes || 0)], {
      encoding: "utf8",
      timeout: 6_000,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024,
    }, (error, stdout) => {
      if (error || !stdout) return resolveJob(null);
      try {
        const asset = JSON.parse(stdout);
        const posterPath = safeMediaPath(asset.posterPath);
        const videoPath = safeMediaPath(asset.videoPath);
        resolveJob(posterPath ? { ...metadata, ...asset, posterPath, videoPath } : null);
      } catch {
        resolveJob(null);
      }
    });
  });
  videoJobs.set(key, job);
  void job.then((result) => {
    if (!result) setTimeout(() => { if (videoJobs.get(key) === job) videoJobs.delete(key); }, 15_000).unref();
    while (videoJobs.size > 48) videoJobs.delete(videoJobs.keys().next().value);
  });
  return job;
}

const server = createServer(async (request, response) => {
  const origin = request.headers.origin || "";
  if (request.method === "OPTIONS") return json(response, 204, {}, origin);
  const url = new URL(request.url || "/", `http://${host}:${port}`);

  try {
    if (url.pathname === "/api/health") {
      const sync = syncStatus();
      return json(response, 200, {
        ok: true,
        source: source(),
        readonly: true,
        network: "local-only",
        startedAt,
        decryptedDirConfigured: Boolean(decryptedDir),
        keyExtraction: "disabled",
        llmConfigured: llm.configured,
        voiceTranscription: voiceTranscriber.status(),
        sync,
      }, origin);
    }
    if (url.pathname === "/api/sync/status") return json(response, 200, { sync: syncStatus(), source: source() }, origin);
    if (url.pathname === "/api/voice/status") return json(response, 200, { transcription: voiceTranscriber.status(), source: source() }, origin);
    if (url.pathname === "/api/llm/status") return json(response, 200, { llm: { ...publicLlmStatus(llm), history: llmHistory.status() } }, origin);
    if (url.pathname === "/api/llm/probe" && request.method === "POST") {
      const body = await readBody(request);
      const modelId = String(body.modelId || llm.defaultModelId || "");
      const model = llm.models?.find((item) => item.id === modelId);
      try {
        const result = await chatWithLlm({
          question: "只回复：连接成功",
          session: { name: "脱敏链路测试" },
          messages: [{ id: "probe-1", sender: "测试", content: "这是一条不含任何微信内容的连通性测试。", timestamp: Date.now(), type: "text" }],
          modelId,
        }, llm);
        if (model) {
          model.verified = true;
          model.lastError = "";
          model.lastCheckedAt = Date.now();
        }
        return json(response, 200, { ok: true, model: result.model, modelId: result.modelId }, origin);
      } catch (error) {
        if (model && error instanceof LlmRequestError) {
          model.verified = false;
          model.lastError = error.message;
          model.lastCheckedAt = Date.now();
        }
        throw error;
      }
    }
    if (url.pathname === "/api/llm/history" && request.method === "GET") {
      const query = url.searchParams.get("q") || "";
      const username = url.searchParams.get("username") || "";
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 60, 1), 100);
      return json(response, 200, { histories: llmHistory.list({ query, username, limit }), history: llmHistory.status() }, origin);
    }
    if (url.pathname.startsWith("/api/llm/history/") && request.method === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/api/llm/history/".length));
      const history = llmHistory.get(id);
      return json(response, history ? 200 : 404, history ? { history } : { error: "没有找到这条 LLM 历史记录" }, origin);
    }
    if (url.pathname.startsWith("/api/media/") && request.method === "GET") {
      const parts = url.pathname.slice("/api/media/".length).split("/");
      if (parts.length !== 2) return json(response, 404, { error: "media not found" }, origin);
      const username = decodeURIComponent(parts[0]);
      const localId = Number(parts[1]);
      if (!username || !Number.isSafeInteger(localId) || localId < 0) return json(response, 400, { error: "invalid media reference" }, origin);
      const current = store();
      const variant = url.searchParams.get("variant") === "full" ? "full" : "thumbnail";
      const token = current?.imageToken(username, localId) || "";
      const image = token ? await decodeMedia(username, token, variant) : null;
      return image ? binary(response, 200, image, origin) : json(response, 404, { error: "local image is unavailable" }, origin);
    }
    if (url.pathname.startsWith("/api/video/") && ["GET", "HEAD"].includes(request.method || "")) {
      const parts = url.pathname.slice("/api/video/".length).split("/");
      if (parts.length !== 3) return json(response, 404, { error: "video not found" }, origin);
      const username = decodeURIComponent(parts[0]);
      const localId = Number(parts[1]);
      const variant = parts[2];
      if (!username || !Number.isSafeInteger(localId) || localId < 0 || !["poster", "content"].includes(variant)) return json(response, 400, { error: "invalid video reference" }, origin);
      const asset = await resolveVideo(username, localId);
      const path = variant === "poster" ? asset?.posterPath : asset?.videoPath;
      const sent = localFile(request, response, path, variant === "poster" ? "image/jpeg" : "video/mp4", origin);
      return sent ? undefined : json(response, 404, { error: variant === "poster" ? "local video poster is unavailable" : "local video is unavailable" }, origin);
    }
    if (url.pathname === "/api/sessions") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 80, 1), 2000);
      const category = url.searchParams.get("category") || "";
      return json(response, 200, { sessions: sessions(limit, category), source: source(), category: ["chat", "official"].includes(category) ? category : "all" }, origin);
    }
    if (url.pathname === "/api/contacts") {
      const query = (url.searchParams.get("q") || "").toLowerCase();
      const snapshot = contactSnapshot();
      const list = snapshot.contacts.filter((contact) => !query || `${contact.name} ${contact.remark} ${contact.username}`.toLowerCase().includes(query));
      return json(response, 200, { contacts: list, revision: snapshot.revision, source: source() }, origin);
    }
    if (url.pathname.startsWith("/api/contacts/")) {
      const username = decodeURIComponent(url.pathname.slice("/api/contacts/".length));
      const current = store();
      const contact = current ? current.contactDetail(username) : contacts().find((item) => item.username === username) || null;
      return json(response, contact ? 200 : 404, contact ? { contact, source: source() } : { error: "contact not found" }, origin);
    }
    if (url.pathname.startsWith("/api/chats/") && url.pathname.endsWith("/messages")) {
      const username = decodeURIComponent(url.pathname.slice("/api/chats/".length, -"/messages".length));
      const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
      const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
      const beforeSeq = /^-?\d+$/.test(url.searchParams.get("beforeSeq") || "") ? url.searchParams.get("beforeSeq") : "";
      const page = messages(username, { limit, before, beforeSeq });
      const current = store();
      const total = current ? current.messageCount(username) : messagesFor(username).length;
      const oldestTimestamp = page[0]?.timestamp || before;
      const oldestSeq = page[0]?.sortSeq || beforeSeq;
      const hasMore = current ? current.hasMessagesBefore(username, { before: oldestTimestamp, beforeSeq: oldestSeq }) : page.length > 0 && oldestTimestamp > Math.min(...messagesFor(username).map((message) => message.timestamp));
      return json(response, 200, { session: sessionByUsername(username), messages: page, total, hasMore, nextBefore: oldestTimestamp, nextBeforeSeq: oldestSeq || "", source: source() }, origin);
    }
    const voiceTranscriptMatch = /^\/api\/chats\/([^/]+)\/voice\/(\d+)\/transcript$/.exec(url.pathname);
    if (voiceTranscriptMatch && request.method === "POST") {
      const username = decodeURIComponent(voiceTranscriptMatch[1]);
      const localId = Number(voiceTranscriptMatch[2]);
      const body = await readBody(request);
      const current = store();
      if (!current) return json(response, 404, { error: "当前没有可读取的微信语音数据库", code: "VOICE_DATABASE_UNAVAILABLE" }, origin);
      const voice = current.voiceBlob(username, localId, String(body.serverId || ""), Number(body.createTime || 0));
      if (!voice) return json(response, 404, { error: "没有找到这条语音的本地音频数据", code: "VOICE_DATA_UNAVAILABLE" }, origin);
      const identity = { username, localId: voice.localId || localId, serverId: voice.serverId || String(body.serverId || ""), createTime: (voice.createTime || 0) * 1000 || Number(body.createTime || 0) };
      const transcription = await voiceTranscriber.transcribe(identity, voice.data);
      return json(response, 200, { transcription, source: source(), readonly: true }, origin);
    }
    if (url.pathname.startsWith("/api/groups/") && url.pathname.endsWith("/members")) {
      const username = decodeURIComponent(url.pathname.slice("/api/groups/".length, -"/members".length));
      const current = store();
      return json(response, 200, { username, members: current ? current.groupMembers(username) : demoMembers, source: source() }, origin);
    }
    if (url.pathname === "/api/search") {
      const query = (url.searchParams.get("q") || "").trim();
      if (!query) return json(response, 200, { results: [], source: source() }, origin);
      const current = store();
      const results = current ? current.search(query) : demoSessions.flatMap((session) => messagesFor(session.username).filter((message) => `${message.sender} ${message.content}`.toLowerCase().includes(query.toLowerCase())).map((message) => ({ ...message, chat: session.name, username: session.username }))).sort((a, b) => b.timestamp - a.timestamp).slice(0, 60);
      return json(response, 200, { query, results, source: source() }, origin);
    }
    if (url.pathname === "/api/heatmap") {
      const month = url.searchParams.get("month") || shanghaiMonth();
      if (!validMonth(month)) return json(response, 400, { error: "month must use YYYY-MM" }, origin);
      const username = String(url.searchParams.get("chat") || "");
      const current = store();
      const selectedSession = username ? sessionByUsername(username) : null;
      const targetUsernames = username
        ? [username]
        : current ? current.chatUsernames({ includeFolded: true }) : demoSessions.filter((session) => session.category === "chat").map((session) => session.username);
      const counts = current ? current.monthlyActivity(month, targetUsernames) : demoActivity(month, username);
      const scope = username ? "current" : "all";
      const scopeName = username ? selectedSession?.name || username : "全部聊天（含折叠）";
      return json(response, 200, { heatmap: heatmapPayload(month, counts, scope, scopeName), source: source(), readonly: true }, origin);
    }
    if (url.pathname === "/api/stats") {
      const username = url.searchParams.get("chat") || sessions()[0]?.username;
      const session = sessionByUsername(username);
      const analysis = analysisMessages(username, url.searchParams.get("period"), 500);
      return json(response, 200, { summary: summarize(analysis.messages, session), analysis: { period: analysis.period, startAt: analysis.startAt }, source: source() }, origin);
    }
    if (url.pathname === "/api/agent/summarize" && request.method === "POST") {
      const body = await readBody(request);
      const username = body.username || sessions()[0]?.username;
      const session = sessionByUsername(username);
      const analysis = analysisMessages(username, body.period, Math.min(Number(body.limit) || 500, 1000));
      return json(response, 200, { summary: summarize(analysis.messages, session), analysis: { period: analysis.period, startAt: analysis.startAt }, source: source() }, origin);
    }
    if (url.pathname === "/api/agent/ask" && request.method === "POST") {
      const body = await readBody(request);
      const username = body.username || sessions()[0]?.username;
      const question = String(body.question || "").trim();
      if (!question) return json(response, 400, { error: "问题不能为空" }, origin);
      const session = sessionByUsername(username);
      const analysis = analysisMessages(username, body.period, 1000);
      return json(response, 200, { result: answerQuestion(question, analysis.messages, session), analysis: { period: analysis.period, startAt: analysis.startAt }, source: source() }, origin);
    }
    if (url.pathname === "/api/llm/chat" && request.method === "POST") {
      const body = await readBody(request);
      const username = String(body.username || sessions()[0]?.username || "");
      const question = String(body.question || "").trim();
      if (!question) return json(response, 400, { error: "问题不能为空", code: "EMPTY_QUESTION" }, origin);
      const session = sessionByUsername(username);
      const all = messages(username, { limit: 1000 });
      const modelId = String(body.modelId || "");
      const model = llm.models?.find((item) => item.id === (modelId || llm.defaultModelId));
      try {
        const result = await chatWithLlm({
          question,
          session,
          messages: all,
          history: Array.isArray(body.history) ? body.history : [],
          referenceIds: Array.isArray(body.referenceIds) ? body.referenceIds.slice(0, 20) : [],
          modelId,
        }, llm);
        if (model) {
          model.verified = true;
          model.lastError = "";
          model.lastCheckedAt = Date.now();
        }
        let conversation = null;
        try {
          conversation = llmHistory.recordExchange({
            conversationId: String(body.conversationId || ""),
            username,
            sessionName: session.name || session.username,
            question,
            answer: result.answer,
            citations: result.citations,
            modelId: result.modelId,
            model: result.model,
            provider: result.provider,
            contextMessages: result.contextMessages,
            usage: result.usage,
          });
        } catch (historyError) {
          console.warn(`LLM history: ${historyError.message}`);
        }
        return json(response, 200, { result: { ...result, conversationId: conversation?.id || String(body.conversationId || "") }, conversation, source: source() }, origin);
      } catch (error) {
        if (model && error instanceof LlmRequestError) {
          model.verified = false;
          model.lastError = error.message;
          model.lastCheckedAt = Date.now();
          console.warn(`LLM ${model.id}: ${error.code} (${error.status})`);
        }
        throw error;
      }
    }
    return json(response, 404, { error: "not found" }, origin);
  } catch (error) {
    if (error instanceof LlmRequestError) return json(response, error.status, { error: error.message, code: error.code }, origin);
    if (error instanceof VoiceTranscriptionError) return json(response, error.status, { error: error.message, code: error.code }, origin);
    console.error(error);
    return json(response, 500, { error: "local service error" }, origin);
  }
});

server.listen(port, host, () => {
  console.log(`Weixin AgentOS local API: http://${host}:${port}`);
  console.log(`Data source: ${source()}${store() ? ` (${decryptedDir})` : " (safe demo fallback)"}`);
  console.log("Read-only mode: enabled; key extraction and WeChat modification are disabled");
  console.log(`LLM: ${llm.configured ? `${llm.models.length} selectable models` : "not configured"}`);
  console.log(`LLM history: ${llmHistory.status().enabled ? `${llmHistory.status().conversationCount} local conversations` : "disabled"}`);
  console.log(`Voice transcription: ${voiceTranscriber.status().configured ? `${voiceTranscriber.status().engine} (${voiceTranscriber.status().model})` : "not configured"}`);
  for (const warning of llm.warnings) console.warn(`LLM warning: ${warning}`);
});
