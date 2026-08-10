import assert from "node:assert/strict";
import test from "node:test";
import { isTimelineNearLatest, mergeConversationMessages, sessionHasNewMessages } from "../app/message-sync.ts";

test("only the selected session's own metadata change counts as a new message", () => {
  const current = { username: "current", timestamp: 100, lastMessage: "old", unread: 0 };
  assert.equal(sessionHasNewMessages(current, { ...current, timestamp: 101, lastMessage: "new" }), true);
  assert.equal(sessionHasNewMessages(current, { ...current, username: "other", timestamp: 101 }), false);
});

test("background refresh merges new messages without dropping loaded history", () => {
  const existing = [
    { id: "old", timestamp: 10, content: "older history" },
    { id: "shared", timestamp: 20, content: "stale" },
  ];
  const incoming = [
    { id: "shared", timestamp: 20, content: "updated" },
    { id: "new", timestamp: 30, content: "latest" },
  ];
  const merged = mergeConversationMessages(existing, incoming);
  assert.deepEqual(merged.map((message) => message.id), ["old", "shared", "new"]);
  assert.equal(merged[1].content, "updated");
});

test("auto-follow only happens when the reader is already near the latest message", () => {
  assert.equal(isTimelineNearLatest({ scrollHeight: 1000, scrollTop: 420, clientHeight: 500 }), true);
  assert.equal(isTimelineNearLatest({ scrollHeight: 1000, scrollTop: 100, clientHeight: 500 }), false);
});
