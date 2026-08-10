import assert from "node:assert/strict";
import test from "node:test";

import { summarize } from "../local/agent.mjs";

test("active speaker statistics keep real avatars and exclude group system records", () => {
  const aliceAvatar = { label: "A", tone: "orange", url: "https://example.test/alice.jpg" };
  const summary = summarize([
    { id: 1, senderId: "wxid_alice", sender: "Alice 完整姓名", avatar: aliceAvatar, type: "text", content: "第一条", timestamp: 1 },
    { id: 2, senderId: "wxid_alice", sender: "Alice 完整姓名", avatar: aliceAvatar, type: "image", content: "图片", timestamp: 2 },
    { id: 3, senderId: "wxid_bob", sender: "Bob", avatar: { label: "B", tone: "blue" }, type: "text", content: "收到", timestamp: 3 },
    { id: 4, senderId: "room@chatroom", sender: "群聊名称", type: "system", content: "系统消息", timestamp: 4 },
    { id: 5, senderId: "", sender: "系统", type: "system", content: "撤回", timestamp: 5 },
  ], { name: "测试群" });

  assert.equal(summary.metrics.participants, 2);
  assert.deepEqual(summary.topSpeakers.map(({ senderId, name, count }) => ({ senderId, name, count })), [
    { senderId: "wxid_alice", name: "Alice 完整姓名", count: 2 },
    { senderId: "wxid_bob", name: "Bob", count: 1 },
  ]);
  assert.deepEqual(summary.topSpeakers[0].avatar, aliceAvatar);
});
