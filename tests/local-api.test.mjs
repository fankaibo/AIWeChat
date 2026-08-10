import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const port = 18876;
let api;
const historyDirectory = mkdtempSync(join(tmpdir(), "weixin-agentos-api-test-"));

test.before(async () => {
  const { OPENAI_API_KEY, WEIXIN_LLM_API_KEY, WEIXIN_LLM_BASE_URL, WEIXIN_LLM_KEY_FILE, ...testEnv } = process.env;
  void OPENAI_API_KEY; void WEIXIN_LLM_API_KEY; void WEIXIN_LLM_BASE_URL; void WEIXIN_LLM_KEY_FILE;
  api = spawn(process.execPath, ["local/server.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: { ...testEnv, WEIXIN_AGENTOS_PORT: String(port), WEIXIN_LLM_KEY_FILE: "disabled", WEIXIN_LLM_HISTORY_FILE: join(historyDirectory, "history.json") },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("local API did not start");
});

test.after(() => {
  api?.kill("SIGTERM");
  rmSync(historyDirectory, { recursive: true, force: true });
});

test("local API is read-only and safely falls back to demo data", async () => {
  const health = await fetch(`http://127.0.0.1:${port}/api/health`).then((response) => response.json());
  assert.equal(health.ok, true);
  assert.equal(health.readonly, true);
  assert.equal(health.keyExtraction, "disabled");
  assert.equal(health.network, "local-only");
  assert.equal(health.llmConfigured, false);
  assert.equal(health.voiceTranscription.localOnly, true);
  assert.equal(health.voiceTranscription.engine, "openai-whisper-local");
  assert.equal(health.voiceTranscription.mediaDatabaseReady, false);
  assert.equal(health.voiceTranscription.wechatVoiceReady, false);
  assert.equal(health.sync.mode, "demo");
  assert.equal(health.sync.readonly, true);
  const sync = await fetch(`http://127.0.0.1:${port}/api/sync/status`).then((response) => response.json());
  assert.equal(sync.sync.state, "disabled");
  const llmStatus = await fetch(`http://127.0.0.1:${port}/api/llm/status`).then((response) => response.json());
  assert.equal(llmStatus.llm.configured, false);
  assert.equal(llmStatus.llm.store, false);
  assert.equal(llmStatus.llm.history.enabled, true);
  const histories = await fetch(`http://127.0.0.1:${port}/api/llm/history`).then((response) => response.json());
  assert.deepEqual(histories.histories, []);
  const voiceStatus = await fetch(`http://127.0.0.1:${port}/api/voice/status`).then((response) => response.json());
  assert.equal(voiceStatus.transcription.localOnly, true);
});

test("sessions, messages, search and agent endpoints respond", async () => {
  const sessions = await fetch(`http://127.0.0.1:${port}/api/sessions`).then((response) => response.json());
  assert.ok(sessions.sessions.length > 3);
  const chats = await fetch(`http://127.0.0.1:${port}/api/sessions?category=chat&limit=500`).then((response) => response.json());
  const official = await fetch(`http://127.0.0.1:${port}/api/sessions?category=official&limit=500`).then((response) => response.json());
  assert.equal(chats.category, "chat");
  assert.ok(chats.sessions.length > 0);
  assert.ok(chats.sessions.every((session) => session.category === "chat"));
  assert.equal(official.category, "official");
  assert.ok(official.sessions.length > 0);
  assert.ok(official.sessions.every((session) => session.category === "official"));
  const username = encodeURIComponent(sessions.sessions[0].username);
  const messages = await fetch(`http://127.0.0.1:${port}/api/chats/${username}/messages`).then((response) => response.json());
  assert.ok(messages.messages.length > 3);
  assert.equal(messages.total, messages.messages.length);
  const firstPage = await fetch(`http://127.0.0.1:${port}/api/chats/${username}/messages?limit=2`).then((response) => response.json());
  assert.equal(firstPage.messages.length, 2);
  assert.equal(firstPage.total, messages.total);
  assert.equal(firstPage.hasMore, true);
  const olderPage = await fetch(`http://127.0.0.1:${port}/api/chats/${username}/messages?limit=2&before=${firstPage.messages[0].timestamp}`).then((response) => response.json());
  assert.equal(olderPage.messages.length, 2);
  assert.ok(olderPage.messages.every((message) => message.timestamp < firstPage.messages[0].timestamp));
  const members = await fetch(`http://127.0.0.1:${port}/api/groups/${username}/members`).then((response) => response.json());
  assert.ok(members.members.length > 3);
  const contactList = await fetch(`http://127.0.0.1:${port}/api/contacts`).then((response) => response.json());
  assert.equal(contactList.revision, "demo");
  assert.ok(contactList.contacts.length > 3);
  const contact = await fetch(`http://127.0.0.1:${port}/api/contacts/${encodeURIComponent("wxid_lin")}`).then((response) => response.json());
  assert.equal(contact.contact.name, "林然");
  const search = await fetch(`http://127.0.0.1:${port}/api/search?q=Agent`).then((response) => response.json());
  assert.ok(search.results.length > 0);
  const month = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
  const heatmap = await fetch(`http://127.0.0.1:${port}/api/heatmap?month=${month}`).then((response) => response.json());
  assert.equal(heatmap.readonly, true);
  assert.equal(heatmap.heatmap.scope, "all");
  assert.ok([28, 29, 30, 31].includes(heatmap.heatmap.days.length));
  assert.equal(heatmap.heatmap.total, heatmap.heatmap.days.reduce((sum, day) => sum + day.count, 0));
  assert.ok(heatmap.heatmap.total > 0);
  const currentHeatmap = await fetch(`http://127.0.0.1:${port}/api/heatmap?month=${month}&chat=${username}`).then((response) => response.json());
  assert.equal(currentHeatmap.heatmap.scope, "current");
  assert.ok(currentHeatmap.heatmap.total > 0);
  const allStats = await fetch(`http://127.0.0.1:${port}/api/stats?chat=${username}`).then((response) => response.json());
  const dailyStats = await fetch(`http://127.0.0.1:${port}/api/stats?chat=${username}&period=day`).then((response) => response.json());
  assert.equal(dailyStats.analysis.period, "day");
  assert.ok(dailyStats.analysis.startAt > 0);
  assert.ok(dailyStats.summary.metrics.messages <= allStats.summary.metrics.messages);
  const summary = await fetch(`http://127.0.0.1:${port}/api/agent/summarize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: sessions.sessions[0].username, period: "week" }),
  }).then((response) => response.json());
  assert.ok(summary.summary.overview);
  assert.equal(summary.analysis.period, "week");
  const llmResponse = await fetch(`http://127.0.0.1:${port}/api/llm/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: sessions.sessions[0].username, question: "结论是什么？" }),
  });
  assert.equal(llmResponse.status, 503);
  assert.equal((await llmResponse.json()).code, "LLM_NOT_CONFIGURED");
  const streamedLlmResponse = await fetch(`http://127.0.0.1:${port}/api/llm/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: sessions.sessions[0].username, question: "结论是什么？", stream: true }),
  });
  assert.equal(streamedLlmResponse.status, 200);
  assert.match(streamedLlmResponse.headers.get("content-type") || "", /^text\/event-stream/);
  const streamedBody = await streamedLlmResponse.text();
  assert.match(streamedBody, /event: error/);
  assert.match(streamedBody, /LLM_NOT_CONFIGURED/);
});
