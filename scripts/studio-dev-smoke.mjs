import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "dotenv";
import { createClient } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { verifyDeployment } from "../sdk/deployment.mjs";

const root = resolve(import.meta.dirname, "..");
config({ path: resolve(root, ".env"), quiet: true });
const client = createClient({ chain: studioDevnet, endpoint: process.env.STUDIO_DEV_RPC?.trim() || "https://studio-dev.genlayer.com/api" });
const result = await verifyDeployment({ client, address: process.env.CONTRACT_ADDRESS?.trim(), source: await readFile(resolve(root, "contracts/Recourse.py"), "utf8") });
console.log(JSON.stringify({ ...result, checks: "read-only source/schema/finalized registry", liveAcceptanceComplete: false }, null, 2));
