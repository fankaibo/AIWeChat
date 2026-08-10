import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { chatWithLlm, llmConfig, publicLlmStatus, selectContext, streamChatWithLlm } from "../local/llm.mjs";
import { buildModelCatalog, parseCredentialText, publicModelCatalog } from "../local/model-catalog.mjs";

test("credential text becomes a safe multi-provider model catalog", () => {
  const credentials = parseCredentialText(`
1.minimax：\nkey：mini-fake-secret
2.kimi：\nkey1：kimi-fake-secret-one\nkey2：kimi-fake-secret-two
3.opencode：\nkey1-user@example.com：zen-fake-secret
4.codex：not-an-api-key
5.GLM：glm.fake-secret
6.deepseek api：deepseek-fake-secret
  `);
  const catalog = buildModelCatalog({ credentials, source: { name: "LLMApiKey.rtf", securePermissions: false } });
  const status = publicModelCatalog(catalog);
  assert.ok(status.models.some((model) => model.id === "opencode-gpt-5.6-sol"));
  assert.ok(status.models.some((model) => model.id === "kimi-k2.7-code"));
  assert.ok(status.models.some((model) => model.id === "glm-5.2-coding"));
  assert.equal(status.defaultModelId, "opencode-gpt-5.6-sol");
  assert.equal(status.credentialCounts.opencode, 1);
  assert.equal(JSON.stringify(status).includes("fake-secret"), false);
  assert.ok(status.warnings.some((warning) => warning.includes("Codex")));
});

test("LLM config never exposes the API key", () => {
  const config = llmConfig({ OPENAI_API_KEY: "secret", WEIXIN_LLM_MODEL: "gpt-5.6", WEIXIN_LLM_REASONING: "medium" });
  const status = publicLlmStatus(config);
  assert.equal(config.configured, true);
  assert.equal(status.model, "gpt-5.6");
  assert.equal(status.store, false);
  assert.equal("apiKey" in status, false);
  assert.equal(JSON.stringify(status).includes("secret"), false);
});

test("referenced and relevant messages are selected with stable citation labels", () => {
  const source = [
    { id: "a", sender: "林然", content: "讨论一下发布计划", timestamp: 1, type: "text" },
    { id: "b", sender: "陈川", content: "风险是迁移可能超时", timestamp: 2, type: "text" },
    { id: "c", sender: "我", content: "周四完成迁移回归", timestamp: 3, type: "text" },
  ];
  const selected = selectContext(source, "迁移风险是什么", ["c"], 20);
  assert.deepEqual(selected.map((item) => item.id), ["a", "b", "c"]);
  assert.deepEqual(selected.map((item) => item.label), ["M1", "M2", "M3"]);
});

test("Responses API calls disable storage and map model citations back to messages", async (t) => {
  let requestBody;
  const mock = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "resp_test",
      model: "gpt-5.6",
      output: [{ type: "message", content: [{ type: "output_text", text: "迁移的主要风险是超时。[M2]" }] }],
      usage: { input_tokens: 100, output_tokens: 12, total_tokens: 112 },
    }));
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  t.after(() => mock.close());
  const address = mock.address();
  const config = llmConfig({ OPENAI_API_KEY: "secret", WEIXIN_LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`, WEIXIN_LLM_MODEL: "gpt-5.6" });
  const result = await chatWithLlm({
    question: "迁移风险是什么？",
    session: { name: "测试群" },
    messages: [
      { id: "a", sender: "林然", content: "讨论发布计划", timestamp: 1, type: "text" },
      { id: "b", sender: "陈川", content: "迁移可能超时", timestamp: 2, type: "text" },
    ],
  }, config);
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.model, "gpt-5.6");
  assert.equal(result.citations[0].id, "b");
  assert.equal(result.usage.totalTokens, 112);
});

test("Chat Completions models use the selected safe catalog entry", async (t) => {
  let requestBody;
  const mock = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chat_test",
      model: "provider-test-model",
      choices: [{ message: { role: "assistant", content: "负责人是陈川。[M2]" } }],
      usage: { prompt_tokens: 90, completion_tokens: 8, total_tokens: 98 },
    }));
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  t.after(() => mock.close());
  const address = mock.address();
  const catalog = {
    configured: true,
    defaultModelId: "safe-test-model",
    models: [{ id: "safe-test-model", name: "测试模型", provider: "测试提供方", providerId: "test", model: "provider-test-model", endpoint: `http://127.0.0.1:${address.port}/chat/completions`, protocol: "chat-completions", reasoning: "default", contextLimit: 120, timeoutMs: 10_000, apiKeys: ["fake-secret"] }],
  };
  const result = await chatWithLlm({
    modelId: "safe-test-model",
    question: "负责人是谁？",
    session: { name: "测试群" },
    messages: [
      { id: "a", sender: "林然", content: "讨论发布计划", timestamp: 1, type: "text" },
      { id: "b", sender: "陈川", content: "我负责迁移", timestamp: 2, type: "text" },
    ],
  }, catalog);
  assert.equal(requestBody.model, "provider-test-model");
  assert.equal(requestBody.messages[0].role, "system");
  assert.equal("store" in requestBody, false);
  assert.equal(result.modelId, "safe-test-model");
  assert.equal(result.citations[0].id, "b");
  assert.equal(result.usage.totalTokens, 98);
});

test("Responses API streams text deltas and returns the final cited result", async (t) => {
  let requestBody;
  const mock = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requestBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: response.created\ndata: {"type":"response.created","response":{"id":"resp_stream","model":"gpt-5.6"}}\n\n');
    response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"迁移风险"}\n\n');
    response.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"是超时。[M2]"}\n\n');
    response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_stream","model":"gpt-5.6","usage":{"input_tokens":30,"output_tokens":8,"total_tokens":38}}}\n\n');
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  t.after(() => mock.close());
  const address = mock.address();
  const config = llmConfig({ OPENAI_API_KEY: "secret", WEIXIN_LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`, WEIXIN_LLM_MODEL: "gpt-5.6" });
  const deltas = [];
  const result = await streamChatWithLlm({
    question: "迁移风险是什么？",
    session: { name: "测试群" },
    messages: [
      { id: "a", sender: "林然", content: "讨论发布计划", timestamp: 1, type: "text" },
      { id: "b", sender: "陈川", content: "迁移可能超时", timestamp: 2, type: "text" },
    ],
  }, config, { onDelta: (delta) => deltas.push(delta) });
  assert.equal(requestBody.stream, true);
  assert.equal(requestBody.store, false);
  assert.deepEqual(deltas, ["迁移风险", "是超时。[M2]"]);
  assert.equal(result.answer, "迁移风险是超时。[M2]");
  assert.equal(result.citations[0].id, "b");
  assert.equal(result.usage.totalTokens, 38);
});

test("Chat Completions streaming hides provider think blocks", async (t) => {
  const mock = createServer(async (request, response) => {
    for await (const _chunk of request) void _chunk;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"id":"chat_stream","model":"provider-test-model","choices":[{"delta":{"content":"<think>内部"}}]}\n\n');
    response.write('data: {"id":"chat_stream","model":"provider-test-model","choices":[{"delta":{"content":"推理</think>负责人"}}]}\n\n');
    response.write('data: {"id":"chat_stream","model":"provider-test-model","choices":[{"delta":{"content":"是陈川。[M2]"}}]}\n\n');
    response.end('data: {"id":"chat_stream","model":"provider-test-model","choices":[],"usage":{"prompt_tokens":20,"completion_tokens":6,"total_tokens":26}}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  t.after(() => mock.close());
  const address = mock.address();
  const catalog = {
    configured: true,
    defaultModelId: "safe-test-model",
    models: [{ id: "safe-test-model", name: "测试模型", provider: "测试提供方", providerId: "test", model: "provider-test-model", endpoint: `http://127.0.0.1:${address.port}/chat/completions`, protocol: "chat-completions", reasoning: "default", contextLimit: 120, timeoutMs: 10_000, apiKeys: ["fake-secret"] }],
  };
  const deltas = [];
  const result = await streamChatWithLlm({
    modelId: "safe-test-model",
    question: "负责人是谁？",
    session: { name: "测试群" },
    messages: [
      { id: "a", sender: "林然", content: "讨论发布计划", timestamp: 1, type: "text" },
      { id: "b", sender: "陈川", content: "我负责迁移", timestamp: 2, type: "text" },
    ],
  }, catalog, { onDelta: (delta) => deltas.push(delta) });
  assert.deepEqual(deltas, ["负责人", "是陈川。[M2]"]);
  assert.equal(result.answer, "负责人是陈川。[M2]");
  assert.equal(result.usage.totalTokens, 26);
});
