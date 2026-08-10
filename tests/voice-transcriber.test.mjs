import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalVoiceTranscriber, voiceCacheIdentity } from "../local/voice-transcriber.mjs";

test("voice transcript cache is local, stable and scoped to one WeChat message", () => {
  const directory = mkdtempSync(join(tmpdir(), "weixin-agentos-voice-cache-"));
  try {
    const transcriber = new LocalVoiceTranscriber({ whisperPath: "/bin/echo", pythonPath: "/bin/echo", ffmpegPath: "/bin/echo", cacheDir: directory, model: "base" });
    const first = { username: "room@chatroom", localId: 42, serverId: "9007199254740993123", createTime: 123_000 };
    const second = { ...first, localId: 43 };
    mkdirSync(directory, { recursive: true });
    writeFileSync(transcriber.cachePath(first), JSON.stringify({ status: "available", transcript: "明天下午三点开会", engine: "openai-whisper-local", model: "base" }));
    assert.equal(transcriber.cached(first)?.transcript, "明天下午三点开会");
    assert.equal(transcriber.cached(second), null);
    assert.equal(transcriber.status().localOnly, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("voice cache identity preserves local and server identifiers", () => {
  assert.deepEqual(voiceCacheIdentity({ serverId: "123456789012345678", timestamp: 9000, meta: { localId: 17 } }, "wxid_test"), {
    username: "wxid_test",
    localId: 17,
    serverId: "123456789012345678",
    createTime: 9000,
  });
});
