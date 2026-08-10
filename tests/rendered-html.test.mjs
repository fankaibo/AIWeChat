import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Weixin AgentOS shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Weixin AgentOS/);
  assert.match(html, /WEIXIN AGENTOS/);
  assert.match(html, /AI 技术交流群/);
  assert.match(html, /公众号/);
  assert.match(html, /只读模式/);
  assert.match(html, /已加载 \d+ \/ 共 \d+ 条/);
  assert.match(html, /本地语音数据暂不可用/);
  assert.match(html, /接入你的 LLM/);
  assert.match(html, /API Key 只由本地服务读取/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Starter Project/);
});

test("ships privacy and read-only product copy", async () => {
  const response = await render();
  const html = await response.text();
  assert.match(html, /不会写入数据库/);
  assert.doesNotMatch(html, /对话历史仅保存在本机/);
  assert.match(html, /历史/);
  assert.match(html, /只有主动提问才会发送/);
  assert.match(html, /只读快照/);
});
