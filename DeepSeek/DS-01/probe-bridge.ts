// DS-01 probe: does the CURRENT shared frontend source still satisfy the
// backend bridge anchors (packages/core/frontend.ts)?
// Read-only: buildFrontendAssets only reads the source snapshot.
import { createHash } from "node:crypto";
import path from "node:path";
import { buildFrontendAssets } from "/Users/anyunhong/Desktop/集合agent/backend/agetor/packages/core/frontend.ts";

const dir = "/Users/anyunhong/Desktop/集合agent/apps/web/public";
try {
  const assets = await buildFrontendAssets(dir, "b".repeat(64));
  const hashes = Object.fromEntries(
    Object.entries(assets.sourceHashes).sort(([a], [b]) => a.localeCompare(b)),
  );
  console.log("BRIDGE_BUILD=OK");
  console.log("sourceHashes=" + JSON.stringify(hashes, null, 2));
  console.log("assets=" + JSON.stringify([...assets.assets.keys()].sort()));
  for (const [name, asset] of [...assets.assets].sort()) {
    console.log(`asset ${name} len=${asset.body.length} sha256=${createHash("sha256").update(asset.body).digest("hex")} type=${asset.type}`);
  }
} catch (error) {
  console.log("BRIDGE_BUILD=FAIL");
  console.log(String((error as Error)?.message ?? error));
  process.exitCode = 1;
}
