import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_KEY_FILE = join(homedir(), "Documents", "LLMApiKey.rtf");
const DEFAULT_MODEL_ID = "opencode-gpt-5.6-sol";

const PROVIDER_ALIASES = new Map([
  ["minimax", "minimax"],
  ["kimi", "kimi"],
  ["opencode", "opencode"],
  ["codex", "codex"],
  ["glm", "glm"],
  ["deepseek", "deepseek"],
  ["deepseek api", "deepseek"],
]);

const MODEL_DEFINITIONS = [
  {
    id: "opencode-gpt-5.6-sol",
    credential: "opencode",
    name: "GPT 5.6 Sol",
    provider: "OpenCode Zen",
    providerId: "opencode",
    model: "gpt-5.6-sol",
    endpoint: "https://opencode.ai/zen/v1/responses",
    protocol: "responses",
    reasoning: "high",
    contextWindow: 400_000,
  },
  {
    id: "opencode-gpt-5.6-terra",
    credential: "opencode",
    name: "GPT 5.6 Terra",
    provider: "OpenCode Zen",
    providerId: "opencode",
    model: "gpt-5.6-terra",
    endpoint: "https://opencode.ai/zen/v1/responses",
    protocol: "responses",
    reasoning: "medium",
    contextWindow: 400_000,
  },
  {
    id: "opencode-gpt-5.6-luna",
    credential: "opencode",
    name: "GPT 5.6 Luna",
    provider: "OpenCode Zen",
    providerId: "opencode",
    model: "gpt-5.6-luna",
    endpoint: "https://opencode.ai/zen/v1/responses",
    protocol: "responses",
    reasoning: "medium",
    contextWindow: 400_000,
  },
  {
    id: "opencode-deepseek-v4-flash",
    credential: "opencode",
    name: "DeepSeek V4 Flash",
    provider: "OpenCode Zen",
    providerId: "opencode",
    model: "deepseek-v4-flash",
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
    protocol: "chat-completions",
    reasoning: "default",
    contextWindow: 1_000_000,
  },
  {
    id: "minimax-m2.7",
    credential: "minimax",
    name: "MiniMax M2.7",
    provider: "MiniMax",
    providerId: "minimax",
    model: "MiniMax-M2.7",
    endpoint: "https://api.minimax.io/v1/chat/completions",
    protocol: "chat-completions",
    reasoning: "default",
    contextWindow: 204_800,
  },
  {
    id: "minimax-m2.5",
    credential: "minimax",
    name: "MiniMax M2.5",
    provider: "MiniMax",
    providerId: "minimax",
    model: "MiniMax-M2.5",
    endpoint: "https://api.minimax.io/v1/chat/completions",
    protocol: "chat-completions",
    reasoning: "default",
    contextWindow: 204_800,
  },
  {
    id: "kimi-k2.7-code",
    credential: "kimi",
    name: "Kimi K2.7 Code",
    provider: "Kimi Code",
    providerId: "kimi",
    model: "kimi-for-coding",
    endpoint: "https://api.kimi.com/coding/v1/chat/completions",
    protocol: "chat-completions",
    reasoning: "high",
    contextWindow: 262_144,
  },
  {
    id: "kimi-k3-256k",
    credential: "kimi",
    name: "Kimi K3 256K",
    provider: "Kimi Code",
    providerId: "kimi",
    model: "k3-256k",
    endpoint: "https://api.kimi.com/coding/v1/chat/completions",
    protocol: "chat-completions",
    reasoning: "high",
    contextWindow: 262_144,
  },
  {
    id: "glm-5.2-coding",
    credential: "glm",
    name: "GLM 5.2",
    provider: "GLM Coding Plan",
    providerId: "glm",
    model: "glm-5.2",
    endpoint: "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions",
    protocol: "chat-completions",
    reasoning: "default",
    contextWindow: 1_000_000,
  },
  {
    id: "deepseek-v4-flash",
    credential: "deepseek",
    name: "DeepSeek V4 Flash",
    provider: "DeepSeek",
    providerId: "deepseek",
    model: "deepseek-v4-flash",
    endpoint: "https://api.deepseek.com/chat/completions",
    protocol: "chat-completions",
    reasoning: "default",
    contextWindow: 1_000_000,
  },
  {
    id: "deepseek-v4-pro",
    credential: "deepseek",
    name: "DeepSeek V4 Pro",
    provider: "DeepSeek",
    providerId: "deepseek",
    model: "deepseek-v4-pro",
    endpoint: "https://api.deepseek.com/chat/completions",
    protocol: "chat-completions",
    reasoning: "default",
    contextWindow: 1_000_000,
  },
];

function unique(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter((value) => value.length >= 8))];
}

export function parseCredentialText(text) {
  const result = { minimax: [], kimi: [], opencode: [], codex: [], glm: [], deepseek: [] };
  let section = "";
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const heading = line.match(/^\s*\d+\.\s*([^:：]+?)\s*[:：]\s*(.*)$/i);
    if (heading) {
      section = PROVIDER_ALIASES.get(heading[1].trim().toLowerCase()) || "";
      if (section && heading[2].trim()) result[section].push(heading[2].trim());
      continue;
    }
    if (!section) continue;
    const separator = line.search(/[:：]/);
    const value = separator >= 0 ? line.slice(separator + 1).trim() : line;
    if (value.length >= 8) result[section].push(value);
  }
  for (const key of Object.keys(result)) result[key] = unique(result[key]);
  return result;
}

function readCredentialFile(path) {
  if (!path || path === "disabled" || !existsSync(path)) return null;
  const text = path.toLowerCase().endsWith(".rtf")
    ? execFileSync("textutil", ["-convert", "txt", "-stdout", path], { encoding: "utf8", maxBuffer: 2_000_000 })
    : readFileSync(path, "utf8");
  const stat = statSync(path);
  return {
    path,
    name: basename(path),
    securePermissions: (stat.mode & 0o077) === 0,
    credentials: parseCredentialText(text),
  };
}

function envModel(config) {
  if (!config?.configured) return null;
  return {
    id: "environment-default",
    name: config.model,
    provider: config.provider,
    providerId: config.local ? "local" : "openai",
    model: config.model,
    endpoint: config.endpoint,
    protocol: "responses",
    reasoning: config.effort,
    contextWindow: null,
    apiKeys: config.apiKey ? [config.apiKey] : [""],
    contextLimit: config.contextLimit,
    timeoutMs: config.timeoutMs,
    local: config.local,
  };
}

export function buildModelCatalog({ credentials = {}, source = null, fallbackConfig = null } = {}) {
  const models = MODEL_DEFINITIONS.flatMap((definition) => {
    const apiKeys = unique(credentials[definition.credential] || []);
    return apiKeys.length ? [{ ...definition, apiKeys, contextLimit: fallbackConfig?.contextLimit || 120, timeoutMs: fallbackConfig?.timeoutMs || 90_000, local: false }] : [];
  });
  const fallback = envModel(fallbackConfig);
  if (fallback && !models.some((model) => model.endpoint === fallback.endpoint && model.model === fallback.model)) models.push(fallback);
  const preferred = models.find((model) => model.id === DEFAULT_MODEL_ID)
    || models.find((model) => model.id === "kimi-k2.7-code")
    || models.find((model) => model.id === "deepseek-v4-flash")
    || models[0]
    || null;
  const warnings = [];
  if (source && !source.securePermissions) warnings.push("凭据文件权限较宽，建议在终端执行 chmod 600 收紧为仅当前用户可读。");
  if ((credentials.codex || []).length) warnings.push("检测到 Codex 凭据，但它不是可安全识别的 OpenAI API Key，已跳过，避免误发到错误端点。");
  return {
    configured: models.length > 0,
    models,
    defaultModelId: preferred?.id || "",
    source: source ? { name: source.name, securePermissions: source.securePermissions } : null,
    credentialCounts: Object.fromEntries(Object.entries(credentials).map(([key, values]) => [key, values.length])),
    warnings,
  };
}

export function loadModelCatalog(env, fallbackConfig) {
  const configuredPath = Object.prototype.hasOwnProperty.call(env, "WEIXIN_LLM_KEY_FILE") ? env.WEIXIN_LLM_KEY_FILE : DEFAULT_KEY_FILE;
  let source = null;
  let warning = "";
  try {
    source = readCredentialFile(configuredPath);
  } catch {
    warning = "凭据文件无法读取或解析，未从该文件启用模型。";
  }
  const catalog = buildModelCatalog({ credentials: source?.credentials || {}, source, fallbackConfig });
  if (warning) catalog.warnings.push(warning);
  return catalog;
}

export function publicModelCatalog(catalog) {
  const models = (catalog.models || []).map((model) => ({
    id: model.id,
    name: model.name,
    provider: model.provider,
    model: model.model,
    api: model.protocol,
    reasoning: model.reasoning,
    contextWindow: model.contextWindow,
    credentialReady: model.apiKeys?.length > 0,
    verified: Boolean(model.verified),
    availability: model.verified ? "ready" : (model.lastCheckedAt && model.lastError ? "unavailable" : "unverified"),
    lastError: model.lastError || "",
    lastCheckedAt: Number(model.lastCheckedAt || 0),
  }));
  return {
    models,
    defaultModelId: catalog.defaultModelId,
    credentialSource: catalog.source?.name || (models.length ? "本地环境变量" : "未配置"),
    credentialFileSecure: catalog.source?.securePermissions ?? null,
    credentialCounts: catalog.credentialCounts || {},
    warnings: catalog.warnings || [],
  };
}
