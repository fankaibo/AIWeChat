import assert from "node:assert/strict";
import test from "node:test";

import { isFoldedGroupSession } from "../local/readonly-store.mjs";

test("folded group aggregate and member sessions stay out of the visible session list", () => {
  assert.equal(isFoldedGroupSession("@placeholder_foldgroup"), true);
  assert.equal(isFoldedGroupSession("123456789@chatroom", 0x10000000), true);
  assert.equal(isFoldedGroupSession("123456789@chatroom", 0x10000002), true);
  assert.equal(isFoldedGroupSession("123456789@chatroom", 2), false);
  assert.equal(isFoldedGroupSession("wxid_contact", 0x10000000), false);
  assert.equal(isFoldedGroupSession("brandsessionholder"), false);
});
