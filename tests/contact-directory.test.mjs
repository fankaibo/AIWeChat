import assert from "node:assert/strict";
import test from "node:test";
import { directoryContactKind, isGroupUsername } from "../local/readonly-store.mjs";

test("contact directory excludes cached group members and official accounts", () => {
  assert.equal(directoryContactKind({ username: "wxid_friend", local_type: 1, flag: 3, verify_flag: 0 }), "contact");
  assert.equal(directoryContactKind({ username: "259849800@openim", local_type: 5, flag: 1, verify_flag: 0 }), "contact");
  assert.equal(directoryContactKind({ username: "wxid_group_member", local_type: 3, flag: 4, verify_flag: 0 }), "");
  assert.equal(directoryContactKind({ username: "gh_official", local_type: 1, flag: 3, verify_flag: 24 }), "");
  assert.equal(directoryContactKind({ username: "filehelper", local_type: 1, flag: 2051, verify_flag: 0 }), "");
  assert.equal(directoryContactKind({ username: "wxid_deleted", local_type: 1, flag: 3, delete_flag: 1 }), "");
});

test("contact directory recognizes standard and open-im group ids", () => {
  assert.equal(isGroupUsername("12345@chatroom"), true);
  assert.equal(isGroupUsername("922337203@im.chatroom"), true);
  assert.equal(directoryContactKind({ username: "12345@chatroom", local_type: 2, flag: 2 }), "group");
  assert.equal(directoryContactKind({ username: "922337203@im.chatroom", local_type: 2, flag: 2 }), "group");
  assert.equal(directoryContactKind({ username: "12345@chatroom", local_type: 0, flag: 0 }), "");
});
