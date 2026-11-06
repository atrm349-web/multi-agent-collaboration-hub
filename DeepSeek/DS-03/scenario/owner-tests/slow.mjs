#!/usr/bin/env node
// DS-03 "slow acceptance" oracle.
// Sleeps first so the scenario has a wide, deterministic activity window to
// inject SIGINT / SIGKILL / process-group kills into, then runs the SAME owner
// assertions used by DS-02 (single source of truth for the oracle).
//
// SLOW_SECONDS (default 45) is read from the environment of the hub process.
import { spawn } from "node:child_process";
import path from "node:path";

const seconds = Number(process.env.DS03_SLOW_SECONDS ?? "45");
const check = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "..", "..", "DS-02", "S1-auto-rework", "owner-tests", "check.mjs",
);

console.log(`slow oracle: sleeping ${seconds}s to widen the activity window`);
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const child = spawn(process.execPath, [check], { cwd: process.cwd(), stdio: "inherit" });
child.on("close", (code) => process.exit(code ?? 1));
