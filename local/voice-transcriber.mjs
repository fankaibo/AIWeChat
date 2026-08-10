import { createHash } from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";

const MAX_VOICE_BYTES = 24 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const TRANSCRIPT_CACHE_VERSION = 2;

function executable(path) {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

function firstExecutable(values) {
  for (const value of values.filter(Boolean)) {
    const path = resolve(value);
    if (executable(path)) return path;
  }
  return "";
}

function pythonModuleReady(pythonPath, moduleName) {
  if (!pythonPath) return false;
  const result = spawnSync(pythonPath, ["-c", `import importlib.util, sys; sys.exit(0 if importlib.util.find_spec(${JSON.stringify(moduleName)}) else 1)`], { encoding: "utf8", timeout: 10_000 });
  return !result.error && result.status === 0;
}

function run(path, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    execFile(path, args, {
      encoding: "utf8",
      timeout: options.timeout || DEFAULT_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: options.maxBuffer || 2 * 1024 * 1024,
      env: options.env || process.env,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message || "").trim().split("\n").slice(-3).join(" ");
        reject(new Error(detail || error.message));
        return;
      }
      resolveRun({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function audioFormat(data) {
  const bytes = Buffer.from(data || []);
  const offset = bytes[0] === 0x02 && bytes.subarray(1, 10).toString("ascii") === "#!SILK_V3" ? 1 : 0;
  if (bytes.subarray(offset, offset + 9).toString("ascii") === "#!SILK_V3") return { kind: "silk", extension: "silk", offset };
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF") return { kind: "direct", extension: "wav", offset: 0 };
  if (bytes.subarray(0, 6).toString("ascii") === "#!AMR\n") return { kind: "direct", extension: "amr", offset: 0 };
  if (bytes.subarray(0, 4).toString("ascii") === "fLaC") return { kind: "direct", extension: "flac", offset: 0 };
  if (bytes.subarray(0, 4).toString("ascii") === "OggS") return { kind: "direct", extension: "ogg", offset: 0 };
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp") return { kind: "direct", extension: "m4a", offset: 0 };
  return { kind: "silk", extension: "silk", offset: 0 };
}

const pysilkDecodeScript = `
import sys
import pysilk
with open(sys.argv[1], "rb") as source, open(sys.argv[2], "wb") as target:
    pysilk.decode(source, target, 24000)
`;

function cleanTranscript(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function safeIdentity(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 28);
}

export class VoiceTranscriptionError extends Error {
  constructor(message, code = "VOICE_TRANSCRIPTION_FAILED", status = 500) {
    super(message);
    this.name = "VoiceTranscriptionError";
    this.code = code;
    this.status = status;
  }
}

export class LocalVoiceTranscriber {
  constructor(options = {}) {
    this.whisperPath = firstExecutable([
      options.whisperPath,
      process.env.WEIXIN_WHISPER_PATH,
      join(homedir(), "whisper-env", "bin", "whisper"),
      "/opt/homebrew/bin/whisper",
      "/usr/local/bin/whisper",
    ]);
    this.pythonPath = firstExecutable([
      options.pythonPath,
      process.env.WEIXIN_WHISPER_PYTHON,
      this.whisperPath ? join(resolve(this.whisperPath, "..", ".."), "bin", "python") : "",
      join(homedir(), "whisper-env", "bin", "python"),
      process.env.VIRTUAL_ENV ? join(process.env.VIRTUAL_ENV, "bin", "python") : "",
      "/opt/homebrew/bin/python3",
      "/usr/local/bin/python3",
      "/usr/bin/python3",
    ]);
    this.ffmpegPath = firstExecutable([
      options.ffmpegPath,
      process.env.WEIXIN_FFMPEG_PATH,
      "/opt/homebrew/bin/ffmpeg",
      "/usr/local/bin/ffmpeg",
      "/usr/bin/ffmpeg",
    ]);
    this.model = String(options.model || process.env.WEIXIN_WHISPER_MODEL || "small");
    this.language = String(options.language || process.env.WEIXIN_WHISPER_LANGUAGE || "zh");
    this.device = String(options.device || process.env.WEIXIN_WHISPER_DEVICE || "cpu");
    this.beamSize = Math.max(1, Math.min(Number(options.beamSize || process.env.WEIXIN_WHISPER_BEAM_SIZE) || 5, 10));
    this.initialPrompt = String(options.initialPrompt ?? process.env.WEIXIN_WHISPER_INITIAL_PROMPT ?? "").trim();
    this.cacheDir = resolve(options.cacheDir || process.env.WEIXIN_VOICE_TRANSCRIPT_DIR || new URL("../.local/voice-transcripts", import.meta.url).pathname);
    this.modelDir = String(options.modelDir || process.env.WEIXIN_WHISPER_MODEL_DIR || "");
    this.whisperModuleReady = pythonModuleReady(this.pythonPath, "whisper");
    this.silkDecoderReady = pythonModuleReady(this.pythonPath, "pysilk");
    this.jobs = new Map();
  }

  status() {
    const whisperReady = Boolean(this.whisperPath || this.whisperModuleReady);
    return {
      configured: Boolean(whisperReady && this.pythonPath && this.ffmpegPath),
      engine: "openai-whisper-local",
      model: this.model,
      language: this.language,
      device: this.device,
      whisperReady,
      whisperCliReady: Boolean(this.whisperPath),
      whisperModuleReady: this.whisperModuleReady,
      silkDecoderReady: this.silkDecoderReady,
      ffmpegReady: Boolean(this.ffmpegPath),
      wechatVoiceReady: Boolean(whisperReady && this.pythonPath && this.ffmpegPath && this.silkDecoderReady),
      localOnly: true,
      cacheEnabled: true,
    };
  }

  cachePath(identity) {
    return join(this.cacheDir, `${safeIdentity(`${identity.username}\n${identity.localId}\n${identity.serverId || ""}\n${identity.createTime || 0}`)}.json`);
  }

  cached(identity) {
    try {
      const value = JSON.parse(readFileSync(this.cachePath(identity), "utf8"));
      const usableStatus = value?.status === "available" || value?.status === "no-speech";
      const currentEngine = value?.engine === "openai-whisper-local";
      const currentConfiguration = value?.cacheVersion === TRANSCRIPT_CACHE_VERSION && value?.model === this.model && value?.language === this.language;
      return usableStatus && currentEngine && currentConfiguration ? value : null;
    } catch {
      return null;
    }
  }

  async transcribe(identity, data) {
    const bytes = Buffer.from(data || []);
    if (!bytes.length) throw new VoiceTranscriptionError("本地语音数据为空", "VOICE_DATA_EMPTY", 404);
    if (bytes.length > MAX_VOICE_BYTES) throw new VoiceTranscriptionError("这条语音超过本地转写大小限制", "VOICE_TOO_LARGE", 413);
    const status = this.status();
    if (!status.configured) throw new VoiceTranscriptionError("本地 Whisper、Python 或 ffmpeg 尚未配置完整", "WHISPER_NOT_CONFIGURED", 503);
    const cached = this.cached(identity);
    if (cached) return { ...cached, cached: true };
    const jobKey = this.cachePath(identity);
    if (this.jobs.has(jobKey)) return this.jobs.get(jobKey);
    const job = this.runTranscription(identity, bytes).finally(() => this.jobs.delete(jobKey));
    this.jobs.set(jobKey, job);
    return job;
  }

  async runTranscription(identity, bytes) {
    mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    chmodSync(this.cacheDir, 0o700);
    const temporary = mkdtempSync(join(tmpdir(), "weixin-agentos-voice-"));
    try {
      const format = audioFormat(bytes);
      if (format.kind === "silk" && !this.silkDecoderReady) throw new VoiceTranscriptionError("本机 Whisper 已连接，但同一 Python 环境尚未安装 silk-python", "SILK_DECODER_NOT_CONFIGURED", 503);
      const rawPath = join(temporary, `voice.${format.extension}`);
      writeFileSync(rawPath, format.offset ? bytes.subarray(format.offset) : bytes, { mode: 0o600 });
      let audioPath = rawPath;
      if (format.kind === "silk") {
        const pcmPath = join(temporary, "voice.pcm");
        const wavPath = join(temporary, "voice.wav");
        try {
          await run(this.pythonPath, ["-c", pysilkDecodeScript, rawPath, pcmPath], { timeout: 90_000 });
        } catch (error) {
          throw new VoiceTranscriptionError(`SILK 解码失败：${error.message}`, "SILK_DECODE_FAILED", 422);
        }
        try {
          await run(this.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", pcmPath, "-ar", "16000", "-ac", "1", wavPath], { timeout: 90_000 });
        } catch (error) {
          throw new VoiceTranscriptionError(`语音格式转换失败：${error.message}`, "VOICE_CONVERSION_FAILED", 422);
        }
        audioPath = wavPath;
      }

      const outputDir = join(temporary, "output");
      mkdirSync(outputDir, { mode: 0o700 });
      const args = [
        audioPath,
        "--model", this.model,
        "--device", this.device,
        "--language", this.language,
        "--task", "transcribe",
        "--output_dir", outputDir,
        "--output_format", "txt",
        "--verbose", "False",
        "--fp16", "False",
        "--temperature", "0",
        "--beam_size", String(this.beamSize),
        "--patience", "1.0",
        "--threads", String(Math.max(1, Math.min(Number(process.env.WEIXIN_WHISPER_THREADS) || 4, 8))),
      ];
      if (this.modelDir) args.push("--model_dir", this.modelDir);
      if (this.initialPrompt) args.push("--initial_prompt", this.initialPrompt);
      try {
        await run(this.whisperPath || this.pythonPath, this.whisperPath ? args : ["-m", "whisper", ...args]);
      } catch (error) {
        throw new VoiceTranscriptionError(`Whisper 转写失败：${error.message}`, "WHISPER_EXECUTION_FAILED", 500);
      }
      const textFile = readdirSync(outputDir).find((name) => extname(name).toLowerCase() === ".txt");
      const text = textFile ? cleanTranscript(readFileSync(join(outputDir, textFile), "utf8")) : "";
      const result = {
        status: text ? "available" : "no-speech",
        transcript: text,
        engine: "openai-whisper-local",
        model: this.model,
        language: this.language,
        localOnly: true,
        cached: false,
        cacheVersion: TRANSCRIPT_CACHE_VERSION,
        createdAt: Date.now(),
        audioHash: createHash("sha256").update(bytes).digest("hex"),
      };
      const cachePath = this.cachePath(identity);
      writeFileSync(cachePath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
      chmodSync(cachePath, 0o600);
      return result;
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
}

export function voiceCacheIdentity(message, username) {
  return {
    username: String(username || ""),
    localId: Number(message?.meta?.localId || 0),
    serverId: String(message?.serverId || message?.meta?.serverId || ""),
    createTime: Number(message?.meta?.createTime || message?.timestamp || 0),
  };
}
