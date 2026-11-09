#!/usr/bin/env node
// DS-03 slow acceptance: widen the activity window so SIGINT / SIGKILL / group
// kills land deterministically inside the test phase, then run the same oracle.
import { spawn } from "node:child_process";
import path from "node:path";

const seconds = Number(process.env.DS03_SLOW_SECONDS ?? "45");
const check = path.join(path.dirname(new URL(import.meta.url).pathname), "check.mjs");
console.log(`slow oracle: sleeping ${seconds}s (pid ${process.pid})`);
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const child = spawn(process.execPath, [check], { cwd: process.cwd(), stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 1));
