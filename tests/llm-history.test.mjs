import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LlmHistoryStore } from "../local/llm-history.mjs";

test("LLM history persists locally and supports chat-scoped full-text search", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "weixin-agentos-history-test-"));
  const path = join(directory, "history.json");
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new LlmHistoryStore(path, { maxConversations: 10, maxTurns: 8 });

  const first = store.recordExchange({
    username: "group-a@chatroom",
    sessionName: "Agent 讨论群",
    question: "迁移风险是什么？",
    answer: "主要风险是超时。[M2]",
    citations: [{ id: "message-2", label: "M2", sender: "陈川", content: "迁移可能超时", timestamp: 2 }],
    modelId: "safe-model",
    model: "provider-model",
    provider: "测试提供方",
    contextMessages: 12,
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
  });
  store.recordExchange({
    username: "group-b@chatroom",
    sessionName: "产品群",
    question: "发布结论？",
    answer: "周四发布。",
    modelId: "safe-model",
    model: "provider-model",
    provider: "测试提供方",
  });

  assert.equal(store.list({ username: "group-a@chatroom" }).length, 1);
  assert.equal(store.list({ query: "超时" })[0].id, first.id);
  assert.equal(store.get(first.id).turns.length, 2);
  assert.equal(JSON.stringify(store.get(first.id)).includes("API_KEY"), false);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(directory).mode & 0o777, 0o700);

  const reopened = new LlmHistoryStore(path);
  assert.equal(reopened.list().length, 2);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 1);
});

test("LLM history continues an existing conversation without crossing WeChat sessions", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "weixin-agentos-history-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = new LlmHistoryStore(join(directory, "history.json"));
  const first = store.recordExchange({ username: "wxid_a", sessionName: "A", question: "第一问", answer: "第一答" });
  const continued = store.recordExchange({ conversationId: first.id, username: "wxid_a", sessionName: "A", question: "第二问", answer: "第二答" });
  assert.equal(continued.id, first.id);
  assert.equal(store.get(first.id).turns.length, 4);
  assert.throws(() => store.recordExchange({ conversationId: first.id, username: "wxid_b", sessionName: "B", question: "错误会话", answer: "不应写入" }), /does not belong/);
});
