import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "dotenv";
import { createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { MANIFEST_HASH } from "../agents/catalog.mjs";
import { fetchPublicUrl } from "../api/http-safety.mjs";
import { validateReleaseConfiguration, verifyDeployment, verifyHostedRelease } from "../sdk/deployment.mjs";

const root = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--live")) throw new Error("Usage: npm run preflight:release -- [--live]. All checks are read-only.");
const source = await readFile(resolve(root, "contracts/Recourse.py"), "utf8");
const metadata = JSON.parse(await readFile(resolve(root, "deploy/addresses.json"), "utf8"));
const backend = { ...parse(await readFile(resolve(root, ".env"))), ...process.env };
const frontend = parse(await readFile(resolve(root, "web/.env.local")));
const release = validateReleaseConfiguration({ backend, frontend, metadata, source });
let live;
if (args.includes("--live")) {
  await verifyDeployment({ client: createClient({ chain: studioDevnet, endpoint: release.rpc }), address: release.contractAddress, source, recordedHash: metadata.sourceSha256 });
  live = await verifyHostedRelease({ release, manifestHash: MANIFEST_HASH, fetcher: fetchPublicUrl });
}
console.log(JSON.stringify({ mode: args.includes("--live") ? "live-read-only" : "offline", ...release, manifestHash: MANIFEST_HASH,
  configurationConsistent: true, live, liveAcceptanceComplete: false }, null, 2));
