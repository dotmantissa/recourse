import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { createAccount, createClient, isSuccessful } from "genlayer-js";
import { studioDevnet } from "genlayer-js/chains";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(root, ".env"), quiet: true });

const RPC = process.env.STUDIO_DEV_RPC?.trim() || "https://studio-dev.genlayer.com/api";
const EXPECTED_CHAIN_ID = 61997;
const key = process.env.DEPLOYER_KEY?.trim();
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  throw new Error("DEPLOYER_KEY must be a 32-byte private key");
}

const source = await readFile(resolve(root, "contracts/Recourse.py"), "utf8");
const runner = source.match(/"Depends":\s*"([^"]+)"/)?.[1];
if (!runner || runner.includes(":latest") || runner.includes(":test")) {
  throw new Error("Recourse.py must use a pinned GenVM runner");
}

const account = createAccount(key);
const client = createClient({ chain: studioDevnet, endpoint: RPC, account });
const chainId = Number(await client.getChainId());
if (chainId !== EXPECTED_CHAIN_ID) {
  throw new Error(`Refusing deployment on chain ${chainId}; expected ${EXPECTED_CHAIN_ID}`);
}

console.log(`Deploying Recourse from ${account.address} to Studio Dev`);
const fees = await client.estimateTransactionFees();
const txHash = await client.deployContract({
  code: source,
  args: [],
  fees: {
    distribution: fees.distribution,
    messageAllocations: fees.messageAllocations,
    feeValue: fees.feeValue,
  },
});
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

const [schema, deployedCode, counts] = await Promise.all([
  client.getContractSchema(address),
  client.getContractCode(address),
  client.readContract({
    address,
    functionName: "get_counts",
    args: [],
    jsonSafeReturn: true,
  }),
]);
const sourceSha256 = createHash("sha256").update(source).digest("hex");
const deployedSha256 = createHash("sha256").update(String(deployedCode)).digest("hex");
if (sourceSha256 !== deployedSha256) {
  throw new Error("Deployed source hash does not match local source");
}

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
  sourceSha256,
  counts: JSON.parse(String(counts)),
  schemaMethods: Object.keys(schema?.methods ?? {}).sort(),
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
  STUDIO_DEV_RPC: RPC,
});
await updateEnv(resolve(root, "web/.env.local"), {
  NEXT_PUBLIC_RECOURSE_RPC: RPC,
  NEXT_PUBLIC_RECOURSE_CHAIN_ID: String(EXPECTED_CHAIN_ID),
  NEXT_PUBLIC_RECOURSE_CONTRACT_ADDRESS: address,
});
console.log(`Recourse deployed at ${address}`);
