import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { ReadonlyStore } from "../local/readonly-store.mjs";

function varint(value) {
  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining) byte |= 0x80;
    bytes.push(byte);
  } while (remaining);
  return Buffer.from(bytes);
}

function field(number, value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([varint((number * 8) + 2), varint(bytes.length), bytes]);
}

function roomBuffer(members) {
  return Buffer.concat(members.map(([username, name]) => field(1, Buffer.concat([field(1, username), field(2, name)]))));
}

test("sessions hydrate names and avatars from all contact metadata without widening the contact directory", () => {
  const root = mkdtempSync(join(tmpdir(), "weixin-session-contact-"));
  const contactDir = join(root, "contact");
  const sessionDir = join(root, "session");
  const messageDir = join(root, "message");
  mkdirSync(contactDir);
  mkdirSync(sessionDir);
  mkdirSync(messageDir);
  try {
    const contactDb = new DatabaseSync(join(contactDir, "contact.db"));
    contactDb.exec(`
      CREATE TABLE contact (
        id INTEGER PRIMARY KEY, username TEXT, nick_name TEXT, remark TEXT,
        remark_quan_pin TEXT, quan_pin TEXT, small_head_url TEXT, big_head_url TEXT,
        verify_flag INTEGER, flag INTEGER, local_type INTEGER, delete_flag INTEGER
      );
      CREATE TABLE chat_room (id INTEGER PRIMARY KEY, username TEXT, ext_buffer BLOB);
      CREATE TABLE chatroom_member (room_id INTEGER, member_id INTEGER);
    `);
    const insertContact = contactDb.prepare("INSERT INTO contact VALUES (?, ?, ?, ?, '', '', ?, '', ?, ?, ?, 0)");
    insertContact.run(1, "wxid_friend", "好友昵称", "好友备注", "https://avatar/friend", 0, 1, 1);
    insertContact.run(2, "wxid_nonfriend", "临时会话昵称", "临时会话备注", "https://avatar/nonfriend", 0, 0, 3);
    insertContact.run(3, "wxid_verified", "认证账号名称", "", "https://avatar/verified", 24, 1, 1);
    insertContact.run(4, "gh_official", "公众号名称", "", "https://avatar/official", 24, 1, 1);
    insertContact.run(5, "room@chatroom", "", "", "https://avatar/group", 0, 0, 2);
    contactDb.prepare("INSERT INTO chat_room VALUES (?, ?, ?)").run(5, "room@chatroom", roomBuffer([["member-a", "甲"], ["member-b", "乙"]]));
    contactDb.close();

    const sessionDb = new DatabaseSync(join(sessionDir, "session.db"));
    sessionDb.exec(`
      CREATE TABLE SessionTable (username TEXT PRIMARY KEY, unread_count INTEGER, summary TEXT, last_timestamp INTEGER, last_msg_type INTEGER);
      CREATE TABLE SessionNoContactInfoTable (username TEXT PRIMARY KEY, session_title TEXT);
    `);
    const insertSession = sessionDb.prepare("INSERT INTO SessionTable VALUES (?, 0, '消息', ?, 1)");
    ["wxid_friend", "wxid_nonfriend", "wxid_verified", "gh_official", "room@chatroom", "unknown-id"].forEach((username, index) => insertSession.run(username, 100 - index));
    sessionDb.prepare("INSERT INTO SessionNoContactInfoTable VALUES (?, ?)").run("wxid_friend", "会话专用标题");
    sessionDb.close();

    const messageDb = new DatabaseSync(join(messageDir, "message_0.db"));
    const table = `Msg_${createHash("md5").update("wxid_nonfriend").digest("hex")}`;
    messageDb.exec(`
      CREATE TABLE Name2Id (user_name TEXT);
      CREATE TABLE [${table}] (
        local_id INTEGER, server_id INTEGER, local_type INTEGER, sort_seq INTEGER,
        create_time INTEGER, real_sender_id INTEGER, message_content TEXT, WCDB_CT_message_content INTEGER
      );
    `);
    messageDb.prepare("INSERT INTO Name2Id(rowid, user_name) VALUES (1, ?)").run("wxid_nonfriend");
    messageDb.prepare(`INSERT INTO [${table}] VALUES (1, 10, 1, 100, 100, 1, '测试消息', 0)`).run();
    messageDb.close();

    const store = new ReadonlyStore(root);
    const directory = store.contacts();
    assert.deepEqual(directory.map((contact) => contact.username), ["wxid_friend"]);

    const sessions = new Map(store.sessions(20).map((session) => [session.username, session]));
    assert.equal(sessions.get("wxid_friend").name, "会话专用标题");
    assert.equal(sessions.get("wxid_nonfriend").name, "临时会话备注");
    assert.equal(sessions.get("wxid_nonfriend").avatar.url, "https://avatar/nonfriend");
    assert.equal(sessions.get("wxid_verified").name, "认证账号名称");
    assert.equal(sessions.get("wxid_verified").category, "official");
    assert.equal(sessions.get("gh_official").name, "公众号名称");
    assert.equal(sessions.get("room@chatroom").name, "甲、乙（群聊）");
    assert.equal(sessions.get("unknown-id").name, "unknown-id");

    const [message] = store.messages("wxid_nonfriend", { limit: 10 });
    assert.equal(message.sender, "临时会话备注");
    assert.equal(message.avatar.url, "https://avatar/nonfriend");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
