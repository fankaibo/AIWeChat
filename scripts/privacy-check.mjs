import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const skippedDirectories = new Set([
  ".git", ".local", ".next", ".vinext", ".wrangler", "coverage", "dist", "node_modules",
]);
const forbiddenExtensions = new Set([
  ".db", ".key", ".log", ".p12", ".pem", ".rdb", ".rtf", ".sqlite", ".sqlite3",
]);
const binaryExtensions = new Set([
  ".gif", ".ico", ".jpeg", ".jpg", ".png", ".webp", ".woff", ".woff2",
]);
const secretPatterns = [
  ["OpenAI-style API key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["database key", /["'=:\s][0-9a-fA-F]{64}["'\s,}]/],
  ["macOS home path", /\/Users\/[A-Za-z0-9._-]+\//],
  ["Linux home path", /\/home\/[A-Za-z0-9._-]+\//],
];

const findings = [];

function inspect(path) {
  const stat = statSync(path);
  const name = path.split("/").at(-1) || "";
  const file = relative(root, path);
  if (file && spawnSync("git", ["check-ignore", "-q", "--", file], { cwd: root }).status === 0) return;
  if (stat.isDirectory()) {
    if (skippedDirectories.has(name)) return;
    for (const entry of readdirSync(path)) inspect(join(path, entry));
    return;
  }

  const extension = extname(name).toLowerCase();
  if (name.startsWith(".env") && name !== ".env.example") findings.push([file, "environment file"]);
  if (name.endsWith(".plist") && !name.endsWith(".plist.example")) findings.push([file, "machine-specific launchd file"]);
  if (forbiddenExtensions.has(extension)) findings.push([file, `forbidden ${extension} artifact`]);
  if (binaryExtensions.has(extension) || stat.size > 5 * 1024 * 1024) return;

  const content = readFileSync(path, "utf8");
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(content)) findings.push([file, label]);
  }
}

for (const entry of readdirSync(root)) inspect(join(root, entry));

if (findings.length) {
  console.error("Privacy check failed:");
  for (const [file, reason] of findings) console.error(`- ${file}: ${reason}`);
  process.exit(1);
}

console.log("Privacy check passed: no local data, machine paths, or recognizable secrets found.");
