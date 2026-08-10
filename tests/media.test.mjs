import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { videoMessageMetadata } from "../local/readonly-store.mjs";
import { decodeWechatImage, resourceToken, WechatMediaResolver, wxgfLargestPartition } from "../local/wechat-media.mjs";

test("extracts the opaque media token from resource metadata", () => {
  const token = "fe8491a856d98aa801cb8f188629fee4";
  const packed = Buffer.concat([Buffer.from([0x12, 0x22, 0x0a, 0x20]), Buffer.from(token)]);
  assert.equal(resourceToken(packed), token);
});

test("decodes a legacy XOR image without writing into the WeChat data tree", () => {
  const directory = mkdtempSync(join(tmpdir(), "weixin-agentos-media-"));
  const path = join(directory, "fixture.dat");
  const plaintext = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const encrypted = Buffer.from(plaintext, (value) => value ^ 0xa5);
  writeFileSync(path, encrypted);
  const result = decodeWechatImage(path, directory);
  assert.equal(result.format, "jpg");
  assert.equal(result.contentType, "image/jpeg");
  assert.deepEqual(result.bytes, plaintext);
});

test("extracts the largest HEVC partition from a WXGF image", () => {
  const small = Buffer.from([0, 0, 0, 1, 0x40, 0x01]);
  const large = Buffer.from([0, 0, 0, 1, 0x42, 0x01, 0xaa, 0xbb, 0xcc]);
  const header = Buffer.concat([Buffer.from("wxgf"), Buffer.from([15]), Buffer.alloc(10)]);
  const fixture = Buffer.concat([
    header,
    Buffer.from([0, 0, 0, small.length]), small,
    Buffer.from([0, 0, 0, large.length]), large,
  ]);
  assert.deepEqual(wxgfLargestPartition(fixture), large);
});

test("matches a cached WeChat video by message time and thumbnail size", () => {
  const accountRoot = mkdtempSync(join(tmpdir(), "weixin-agentos-video-"));
  const directory = join(accountRoot, "msg", "video", "2026-08");
  mkdirSync(directory, { recursive: true });
  const base = "3379b2a2c1d52bcda87fe83a9df1a057";
  const poster = join(directory, `${base}_thumb.jpg`);
  const video = join(directory, `${base}.mp4`);
  writeFileSync(poster, Buffer.alloc(23_642, 1));
  writeFileSync(video, Buffer.from("video fixture"));
  const timestamp = new Date("2026-08-05T09:22:30.000Z").getTime();
  const received = new Date(timestamp + 1_000);
  utimesSync(poster, received, received);
  const result = new WechatMediaResolver(accountRoot).video({ createTime: timestamp, thumbnailBytes: 23_642 });
  assert.equal(result.posterPath, poster);
  assert.equal(result.videoPath, video);
});

test("reads safe display metadata from a WeChat video message", () => {
  const raw = '<msg><videomsg length="6316500" playlength="68" cdnthumblength="23642" cdnthumbwidth="540" cdnthumbheight="304" cdnvideourl="not-exposed" /></msg>';
  assert.deepEqual(videoMessageMetadata(raw, 1785921750000), {
    createTime: 1785921750000,
    duration: 68,
    byteLength: 6316500,
    thumbnailBytes: 23642,
    width: 540,
    height: 304,
  });
});
