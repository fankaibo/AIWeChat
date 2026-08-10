import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const children = new Set();
const projectDir = dirname(dirname(fileURLToPath(import.meta.url)));
const vinextCli = resolve(projectDir, "node_modules/vinext/dist/cli.js");
let stopping = false;

function run(command, args, label) {
  const child = spawn(command, args, { stdio: "inherit", env: process.env, cwd: projectDir });
  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (stopping) return;
    console.error(`${label} exited unexpectedly (${signal || `code ${code ?? "unknown"}`})`);
    stop(code || 1);
  });
  child.on("error", (error) => {
    if (stopping) return;
    console.error(`${label} failed to start: ${error.message}`);
    stop(1);
  });
  return child;
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  setTimeout(() => process.exit(code), 250).unref();
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

run(process.execPath, ["--env-file-if-exists=.env", "local/live-sync.mjs"], "live read-only sync");
run(process.execPath, ["--env-file-if-exists=.env", "local/server.mjs"], "local API");
run(process.execPath, [vinextCli, "dev"], "web app");
