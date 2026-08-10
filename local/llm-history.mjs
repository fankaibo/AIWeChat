import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const VERSION = 1;
const MAX_CONVERSATIONS = 200;
const MAX_TURNS = 80;

function compactText(value, max = 12_000) {
  return String(value || "").replace(/\u0000/g, "").trim().slice(0, max);
}

function safeTimestamp(value, fallback = Date.now()) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function safeCitation(value) {
  if (!value || typeof value !== "object") return null;
  const id = typeof value.id === "number" || typeof value.id === "string" ? value.id : "";
  if (id === "") return null;
  return {
    id,
    label: compactText(value.label, 20),
    sender: compactText(value.sender, 160),
    content: compactText(value.content, 2_000),
    timestamp: safeTimestamp(value.timestamp, 0),
  };
}

function safeTurn(value) {
  if (!value || !["user", "assistant"].includes(value.role)) return null;
  const content = compactText(value.content);
  if (!content) return null;
  const citations = Array.isArray(value.citations) ? value.citations.map(safeCitation).filter(Boolean).slice(0, 20) : [];
  const usage = value.usage && typeof value.usage === "object" ? {
    inputTokens: Math.max(0, Number(value.usage.inputTokens) || 0),
    outputTokens: Math.max(0, Number(value.usage.outputTokens) || 0),
    totalTokens: Math.max(0, Number(value.usage.totalTokens) || 0),
  } : undefined;
  return {
    id: compactText(value.id, 100) || randomUUID(),
    role: value.role,
    content,
    createdAt: safeTimestamp(value.createdAt),
    ...(citations.length ? { citations } : {}),
    ...(value.model ? { model: compactText(value.model, 200) } : {}),
    ...(Number(value.contextMessages) > 0 ? { contextMessages: Number(value.contextMessages) } : {}),
    ...(usage ? { usage } : {}),
  };
}

function safeConversation(value) {
  if (!value || typeof value !== "object") return null;
  const id = compactText(value.id, 100);
  const username = compactText(value.username, 300);
  if (!id || !username) return null;
  const turns = Array.isArray(value.turns) ? value.turns.map(safeTurn).filter(Boolean).slice(-MAX_TURNS) : [];
  return {
    id,
    username,
    sessionName: compactText(value.sessionName, 300) || username,
    title: compactText(value.title, 120) || "LLM 对话",
    createdAt: safeTimestamp(value.createdAt),
    updatedAt: safeTimestamp(value.updatedAt),
    modelId: compactText(value.modelId, 200),
    model: compactText(value.model, 200),
    provider: compactText(value.provider, 200),
    turns,
  };
}

function summaryOf(conversation, query = "") {
  const normalized = query.toLowerCase();
  const matchingTurn = normalized ? conversation.turns.find((turn) => turn.content.toLowerCase().includes(normalized)) : null;
  const lastAssistant = [...conversation.turns].reverse().find((turn) => turn.role === "assistant");
  const preview = compactText(matchingTurn?.content || lastAssistant?.content || conversation.turns.at(-1)?.content, 180);
  return {
    id: conversation.id,
    username: conversation.username,
    sessionName: conversation.sessionName,
    title: conversation.title,
    preview,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    turnCount: conversation.turns.length,
    modelId: conversation.modelId,
    model: conversation.model,
    provider: conversation.provider,
  };
}

export class LlmHistoryStore {
  constructor(path, options = {}) {
    this.path = path;
    this.maxConversations = Math.min(Math.max(Number(options.maxConversations) || MAX_CONVERSATIONS, 1), 2_000);
    this.maxTurns = Math.min(Math.max(Number(options.maxTurns) || MAX_TURNS, 2), 400);
    this.data = { version: VERSION, conversations: [] };
    this.loadError = null;
    this.#load();
  }

  #load() {
    if (!this.path || !existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      this.data = {
        version: VERSION,
        conversations: Array.isArray(parsed.conversations) ? parsed.conversations.map(safeConversation).filter(Boolean).slice(-this.maxConversations) : [],
      };
    } catch (error) {
      this.loadError = error;
    }
  }

  #persist() {
    if (!this.path) return;
    if (this.loadError) throw new Error(`LLM history is unreadable: ${this.loadError.message}`);
    const directory = dirname(this.path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const temporary = `${this.path}.tmp-${process.pid}`;
    writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }

  status() {
    return {
      enabled: Boolean(this.path && !this.loadError),
      localOnly: true,
      conversationCount: this.data.conversations.length,
      maxConversations: this.maxConversations,
      maxTurns: this.maxTurns,
      location: ".local/llm-history.json",
      error: this.loadError ? "本地历史文件无法读取，请检查文件格式和权限。" : "",
    };
  }

  list({ query = "", username = "", limit = 60 } = {}) {
    const normalizedQuery = compactText(query, 300).toLowerCase();
    const normalizedUsername = compactText(username, 300);
    return this.data.conversations
      .filter((conversation) => !normalizedUsername || conversation.username === normalizedUsername)
      .filter((conversation) => {
        if (!normalizedQuery) return true;
        return [conversation.title, conversation.sessionName, conversation.model, conversation.provider, ...conversation.turns.map((turn) => turn.content)]
          .some((value) => value.toLowerCase().includes(normalizedQuery));
      })
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.min(Math.max(Number(limit) || 60, 1), 100))
      .map((conversation) => summaryOf(conversation, normalizedQuery));
  }

  get(id) {
    const conversation = this.data.conversations.find((item) => item.id === String(id || ""));
    return conversation ? structuredClone(conversation) : null;
  }

  recordExchange({ conversationId = "", username, sessionName, question, answer, citations = [], modelId = "", model = "", provider = "", contextMessages = 0, usage }) {
    const safeUsername = compactText(username, 300);
    const safeQuestion = compactText(question);
    const safeAnswer = compactText(answer);
    if (!safeUsername || !safeQuestion || !safeAnswer) throw new Error("LLM history requires a session, question and answer");

    let conversation = conversationId ? this.data.conversations.find((item) => item.id === String(conversationId)) : null;
    if (conversation && conversation.username !== safeUsername) throw new Error("LLM history conversation does not belong to this WeChat session");
    const now = Date.now();
    if (!conversation) {
      conversation = {
        id: randomUUID(),
        username: safeUsername,
        sessionName: compactText(sessionName, 300) || safeUsername,
        title: compactText(safeQuestion.replace(/\s+/g, " "), 80),
        createdAt: now,
        updatedAt: now,
        modelId: compactText(modelId, 200),
        model: compactText(model, 200),
        provider: compactText(provider, 200),
        turns: [],
      };
      this.data.conversations.push(conversation);
    }

    conversation.sessionName = compactText(sessionName, 300) || conversation.sessionName;
    conversation.modelId = compactText(modelId, 200) || conversation.modelId;
    conversation.model = compactText(model, 200) || conversation.model;
    conversation.provider = compactText(provider, 200) || conversation.provider;
    conversation.updatedAt = now;
    conversation.turns.push(
      safeTurn({ id: randomUUID(), role: "user", content: safeQuestion, createdAt: now }),
      safeTurn({ id: randomUUID(), role: "assistant", content: safeAnswer, citations, model, contextMessages, usage, createdAt: now }),
    );
    conversation.turns = conversation.turns.filter(Boolean).slice(-this.maxTurns);
    this.data.conversations = this.data.conversations.sort((a, b) => a.updatedAt - b.updatedAt).slice(-this.maxConversations);
    this.#persist();
    return summaryOf(conversation);
  }
}
