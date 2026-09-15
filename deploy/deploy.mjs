import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createAccount, createClient, isSuccessful } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";
import { describeContract, verifyDeployment } from "../sdk/deployment.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(root, ".env"), quiet: true });

const RPC = process.env.STUDIO_DEV_RPC?.trim() || "https://studio-dev.genlayer.com/api";
const EXPECTED_CHAIN_ID = 61997;
const key = process.env.DEPLOYER_KEY?.trim();

const source = await readFile(resolve(root, "contracts/Recourse.py"), "utf8");
const runner = source.match(/"Depends":\s*"([^"]+)"/)?.[1];
if (!runner || runner.includes(":latest") || runner.includes(":test")) {
  throw new Error("Recourse.py must use a pinned GenVM runner");
}
const description = describeContract(source);
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--run")) throw new Error("Usage: npm run deploy:studio-next -- [--run]");
if (!args.includes("--run")) {
  console.log(JSON.stringify({ mode: "dry-run", chainId: EXPECTED_CHAIN_ID, runner, ...description,
    maximumFeeWei: process.env.DEPLOYMENT_MAX_FEE_WEI || null }, null, 2));
  process.exit(0);
}
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("DEPLOYER_KEY must be a 32-byte private key");
const maxFee = process.env.DEPLOYMENT_MAX_FEE_WEI;
if (!/^[1-9][0-9]{0,77}$/.test(maxFee ?? "")) throw new Error("DEPLOYMENT_MAX_FEE_WEI must explicitly cap the deployment fee");

const account = createAccount(key);
const client = createClient({ chain: studioDevnet, endpoint: RPC, account });
const chainId = Number(await client.getChainId());
if (chainId !== EXPECTED_CHAIN_ID) {
  throw new Error(`Refusing deployment on chain ${chainId}; expected ${EXPECTED_CHAIN_ID}`);
}

console.log(`Deploying Recourse from ${account.address} to Studio Dev`);
const fees = await client.estimateTransactionFees();
if (BigInt(fees.feeValue) > BigInt(maxFee)) throw new Error("Deployment estimate exceeds the explicitly authorized fee cap");
const directory = resolve(root, ".runtime/deployments");
await mkdir(directory, { recursive: true, mode: 0o700 });
const lock = resolve(directory, `${EXPECTED_CHAIN_ID}-${account.address.toLowerCase()}-${description.sourceSha256}.lock`);
let guard;
try { guard = await open(lock, "wx", 0o600); } catch (error) {
  if (error.code === "EEXIST") throw new Error("A deployment is active or uncertain; reconcile its transaction before manually removing the lock");
  throw error;
}
try { await guard.writeFile(`${JSON.stringify({ status: "submitting", sourceSha256: description.sourceSha256, feeWei: String(fees.feeValue) })}\n`); await guard.sync(); } finally { await guard.close(); }
const parent = await open(directory, "r");
try { await parent.sync(); } finally { await parent.close(); }
try {
  const previous = await readFile(resolve(root, "deploy/addresses.json"));
  await writeFile(resolve(directory, `previous-${Date.now()}.json`), previous, { mode: 0o600, flag: "wx" });
} catch (error) { if (error.code !== "ENOENT") throw error; }
const txHash = await client.deployContract({
  code: source,
  args: [],
  fees: {
    distribution: fees.distribution,
    messageAllocations: fees.messageAllocations,
    feeValue: fees.feeValue,
  },
});
const checkpoint = await open(lock, "a");
try { await checkpoint.writeFile(`${JSON.stringify({ status: "submitted", hash: txHash })}\n`); await checkpoint.sync(); } finally { await checkpoint.close(); }
console.log(`Deployment transaction: ${txHash}`);
const receipt = await client.waitForTransactionReceipt({
  hash: txHash,
  waitUntil: "finalized",
  interval: 3000,
  retries: 240,
  fullTransaction: true,
});
if (!isSuccessful(receipt)) {
  throw new Error(`Deployment finalized with execution failure: ${JSON.stringify(receipt)}`);
}

const candidates = [
  receipt.txDataDecoded?.contractAddress,
  receipt.contractAddress,
  receipt.recipient,
  receipt.to_address,
  receipt.to,
];
const address = candidates.find(
  (value) => typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value),
);
if (!address) {
  throw new Error("Deployment receipt did not contain a contract address");
}

const verified = await verifyDeployment({ client, address, source });

const metadata = {
  network: "studio-dev",
  chainId: EXPECTED_CHAIN_ID,
  rpc: RPC,
  explorer: "https://explorer-studio-dev.genlayer.com/",
  contractName: "Recourse",
  contractAddress: address,
  deployerAddress: account.address,
  deploymentTransaction: txHash,
  deployedAt: new Date().toISOString(),
  runner,
  feeValue: String(fees.feeValue),
  sourceSha256: verified.sourceSha256,
  counts: verified.counts,
  schemaMethods: verified.methods,
};
await mkdir(resolve(root, "deploy"), { recursive: true });
await writeFile(
  resolve(root, "deploy/addresses.json"),
  `${JSON.stringify(metadata, null, 2)}\n`,
);

async function updateEnv(path, values) {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {}
  const lines = text.split(/\r?\n/);
  for (const [name, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (index >= 0) lines[index] = `${name}=${value}`;
    else lines.push(`${name}=${value}`);
  }
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${lines.filter(Boolean).join("\n")}\n`, { mode: 0o600 });
  await rename(temporary, path);
  await chmod(path, 0o600);
}
await updateEnv(resolve(root, ".env"), {
  CONTRACT_ADDRESS: address,
  RECOURSE_CONTRACT_ADDRESS: address,
  STUDIO_DEV_RPC: RPC,
});
await updateEnv(resolve(root, "web/.env.local"), {
  NEXT_PUBLIC_RECOURSE_RPC: RPC,
  NEXT_PUBLIC_RECOURSE_CHAIN_ID: String(EXPECTED_CHAIN_ID),
  NEXT_PUBLIC_RECOURSE_CONTRACT_ADDRESS: address,
});
await rm(lock);
console.log(`Recourse deployed at ${address}`);
