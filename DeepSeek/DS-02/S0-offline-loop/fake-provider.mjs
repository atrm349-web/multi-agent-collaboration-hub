#!/usr/bin/env node
// DS-02 S0 simulated provider.
// NOT a model. It stands in for the CLI only in the offline loop self-test, so
// that the state machine (attempt -> rework -> attempt 2 -> review -> approval)
// can be exercised without spending subscription quota. Every S0 artifact is
// labelled "controlled"; real-model evidence is collected separately in S1.
//
// Behaviour:
//   - reviewer prompt  -> JSON verdict, touches no files
//   - rework prompt    -> writes the CORRECT implementation
//   - first attempt    -> writes a NAIVE implementation that fails the owner test
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const prompt = readFileSync(0, "utf8");
const cwd = process.cwd();
const target = path.join(cwd, "src", "amount.mjs");

const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n");

const NAIVE = [
  "export function formatAmount(minorUnits) {",
  "  return String(minorUnits / 100);",
  "}",
  "",
].join("\n");

const CORRECT = [
  "export function formatAmount(minorUnits) {",
  '  if (!Number.isInteger(minorUnits)) {',
  '    throw new RangeError("INVALID_AMOUNT: minor units must be an integer");',
  "  }",
  "  const negative = minorUnits < 0;",
  "  const abs = Math.abs(minorUnits);",
  "  const yuan = Math.floor(abs / 100);",
  "  const fen = abs % 100;",
  '  const grouped = String(yuan).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ",");',
  '  const sign = negative ? "-" : "";',
  '  return sign + "\\u00a5" + grouped + "." + String(fen).padStart(2, "0");',
  "}",
  "",
].join("\n");

emit({ type: "thread.started", thread_id: crypto.randomUUID() });

let message;
if (prompt.includes("You are an independent reviewer")) {
  message = JSON.stringify({ approved: true, findings: [] });
} else if (prompt.includes("rework_instruction")) {
  writeFileSync(target, CORRECT);
  message = "Fixed src/amount.mjs after reading the failing test evidence.";
} else if (process.env.DS0_FIRST_ATTEMPT_CORRECT === "1") {
  // S2 needs the first attempt to PASS so the rejection path is reachable.
  writeFileSync(target, CORRECT);
  message = "Implemented formatAmount in src/amount.mjs.";
} else {
  writeFileSync(target, NAIVE);
  message = "Implemented formatAmount in src/amount.mjs.";
}

emit({ type: "item.completed", item: { type: "agent_message", text: message } });
emit({ type: "turn.completed" });
process.exit(0);
