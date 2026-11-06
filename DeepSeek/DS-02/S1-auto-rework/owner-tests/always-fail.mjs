#!/usr/bin/env node
// DS-02 S3 oracle: an acceptance criterion that can never pass.
// Used only to verify the retry-budget path (attempt cap -> task failed, no approval).
// It deliberately exits non-zero and prints a stable, actionable message.
console.log("always-fail oracle: this criterion is designed to fail on purpose (attempt-cap test)");
console.error("FAIL always-fail: expected 0 but this criterion never passes");
process.exit(1);
