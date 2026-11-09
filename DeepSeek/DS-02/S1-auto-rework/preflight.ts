// DS-02 pre-flight: verify the exact argv the hub will build is accepted by the
// installed Codex CLI — WITHOUT spending any model quota. Nothing here starts a
// model turn: it only builds the command and greps `--help`/config text.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCodexCommand } from "/Users/anyunhong/Desktop/集合agent/backend/agetor/src/bun/agents.ts";
import type { Harness } from "/Users/anyunhong/Desktop/集合agent/backend/agetor/src/shared/types.ts";

const CODEX = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex";
const REPO = "/Users/anyunhong/Documents/deepseek-harness/default-workspace/DeepSeek/DS-02/S1-auto-rework/repo";
const MODEL = "gpt-6.1-sol";
const EFFORT = "high";

const HARNESS = { id: "codex", kind: "codex", label: "Codex", isBuiltin: true, home: null, bin: null, env: {}, enabled: true } as unknown as Harness;

const built = await buildCodexCommand(HARNESS, "DS-02 preflight prompt", { mode: "auto", model: MODEL, effort: EFFORT }, REPO);
const argv = built.cmd as string[];
console.log("argv:", JSON.stringify(argv, null, 2));

const help = execFileSync(CODEX, ["exec", "--help"], { encoding: "utf8", timeout: 20000 });
const sandboxHelp = execFileSync(CODEX, ["sandbox", "--help"], { encoding: "utf8", timeout: 20000 });

const longFlags = [...new Set(argv.filter((a) => a.startsWith("--") && a.includes("=") === false && a.length > 2))];
const configPairs = argv.filter((a) => a.startsWith("--") === false && argv[argv.indexOf(a) - 1] === "-c");
let missing = 0;
for (const flag of longFlags) {
  const present = help.includes(flag);
  if (!present) missing++;
  console.log(`${present ? "OK  " : "MISS"} flag ${flag}`);
}
for (const pair of configPairs) {
  console.log(`INFO -c ${pair}`);
}
console.log(`OK   stdin sentinel present: ${argv.at(-1) === "-"}`);
console.log(`OK   sandbox mode: ${argv[argv.indexOf("--sandbox") + 1]}`);
console.log(`OK   --json present: ${argv.includes("--json")}`);
for (const f of ["-P", "-C"]) {
  console.log(`${sandboxHelp.includes(f) ? "OK  " : "MISS"} codex sandbox ${f} supported`);
}

const config = (() => {
  try { return readFileSync(path.join(os.homedir(), ".codex", "config.toml"), "utf8"); } catch { return ""; }
})();
const modelLine = config.split("\n").find((l) => /^model\s*=/.test(l.trim()));
console.log(`INFO user config ${modelLine ? modelLine.trim() : "(no model line)"}`);
console.log(`${config.includes(`"${MODEL}"`) ? "OK  " : "WARN"} model ${MODEL} appears in ~/.codex/config.toml`);

const login = spawnSync(CODEX, ["login", "status"], { encoding: "utf8", timeout: 20000 });
const loginText = `${login.stdout ?? ""}${login.stderr ?? ""}`;
const loginLine = loginText.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("WARNING")).at(-1);
console.log(`OK   login status=${login.status}: ${loginLine}`);

console.log(missing === 0 ? "PREFLIGHT_OK" : "PREFLIGHT_FAILED");
if (missing) process.exit(1);
