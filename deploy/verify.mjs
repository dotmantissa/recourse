import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "dotenv";
import { createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { RELEASE_CHAIN_ID, verifyDeployment } from "../sdk/deployment.mjs";

const root = resolve(import.meta.dirname, "..");
config({ path: resolve(root, ".env"), quiet: true });
const metadata = JSON.parse(await readFile(resolve(root, "deploy/addresses.json"), "utf8"));
if (metadata.chainId !== RELEASE_CHAIN_ID || !metadata.sourceSha256) throw new Error("Recorded deployment is not a supported release");
const client = createClient({ chain: studioDevnet, endpoint: process.env.STUDIO_DEV_RPC?.trim() || "https://studio-dev.genlayer.com/api" });
const result = await verifyDeployment({ client, address: metadata.contractAddress, recordedHash: metadata.sourceSha256,
  source: await readFile(resolve(root, "contracts/Recourse.py"), "utf8") });
console.log(JSON.stringify({ ...result, checks: "read-only deployment verification", liveAcceptanceComplete: false }, null, 2));
