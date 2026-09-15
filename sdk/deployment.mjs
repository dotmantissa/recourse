import { createHash } from "node:crypto";
import JSONbig from "json-bigint";
import { TransactionHashVariant } from "genlayer-js/types";
import { selectReleaseDeployment } from "./release-config.mjs";

export const RELEASE_CHAIN_ID = 61997;
export const PROTOCOL_VERSION = 2;

export function describeContract(source) {
  const methods = [...source.matchAll(/^    @gl\.public\.(?:view|write(?:\.payable)?)\s*\n    def ([a-zA-Z_]\w*)\(/gm)].map((match) => match[1]).sort();
  if (!methods.includes("accept_job") || !methods.includes("recover_job") || methods.length !== new Set(methods).size) throw new Error("Source is not a supported protocol-v2 contract");
  return { methods, sourceSha256: createHash("sha256").update(source).digest("hex") };
}

export async function verifyDeployment({ client, address, source, recordedHash }) {
  if (!/^0x[0-9a-f]{40}$/i.test(address)) throw new Error("An explicit deployment address is required");
  if (Number(await client.getChainId()) !== RELEASE_CHAIN_ID) throw new Error("RPC chain does not match the release chain");
  const expected = describeContract(source);
  if (recordedHash !== undefined && recordedHash !== expected.sourceSha256) throw new Error("Recorded and local source hashes differ");
  const [schema, code, rawCounts] = await Promise.all([
    client.getContractSchema(address), client.getContractCode(address),
    client.readContract({ address, functionName: "get_counts", args: [], jsonSafeReturn: true, transactionHashVariant: TransactionHashVariant.LATEST_FINAL }),
  ]);
  if (typeof code !== "string" || createHash("sha256").update(code).digest("hex") !== expected.sourceSha256) throw new Error("Deployed and local source hashes differ");
  if (JSON.stringify(Object.keys(schema.methods ?? {}).sort()) !== JSON.stringify(expected.methods)) throw new Error("Deployed method schema differs from the current contract source");
  const counts = typeof rawCounts === "string" ? JSONbig({ storeAsString: true, strict: true }).parse(rawCounts) : rawCounts;
  if (!counts || !["capabilities", "jobs", "disputes", "evidence"].every((field) => Number.isSafeInteger(counts[field]) && counts[field] >= 0)) throw new Error("Invalid finalized registry counts");
  return { chainId: RELEASE_CHAIN_ID, protocolVersion: PROTOCOL_VERSION, contractAddress: address.toLowerCase(), ...expected, counts };
}

export function validateReleaseConfiguration({ backend, frontend, metadata, source, releaseManifest }) {
  const expected = describeContract(source);
  const address = metadata.contractAddress?.toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address ?? "") || metadata.chainId !== RELEASE_CHAIN_ID || metadata.sourceSha256 !== expected.sourceSha256) throw new Error("Deployment metadata does not match the current contract and chain");
  const rpc = metadata.rpc;
  const backendDeployment = selectReleaseDeployment(releaseManifest, { mode: backend.RECOURSE_DEPLOYMENT_MODE,
    contractAddress: backend.RECOURSE_CONTRACT_ADDRESS, chainId: backend.STUDIO_DEV_CHAIN_ID, rpc: backend.STUDIO_DEV_RPC });
  const frontendDeployment = selectReleaseDeployment(releaseManifest, { mode: frontend.NEXT_PUBLIC_RECOURSE_DEPLOYMENT_MODE,
    contractAddress: frontend.NEXT_PUBLIC_RECOURSE_CONTRACT_ADDRESS, chainId: frontend.NEXT_PUBLIC_RECOURSE_CHAIN_ID, rpc: frontend.NEXT_PUBLIC_RECOURSE_RPC });
  for (const deployment of [backendDeployment, frontendDeployment]) {
    if (deployment.contractAddress !== address || deployment.rpc !== rpc || deployment.sourceSha256 !== expected.sourceSha256) {
      throw new Error("Effective deployment differs from the recorded release");
    }
  }
  const adapter = backend.PUBLIC_BASE_URL?.replace(/\/+$/, "");
  if (!adapter || new URL(adapter).protocol !== "https:" || new URL(adapter).origin !== adapter
    || backend.RECOURSE_ADAPTER_URL?.replace(/\/+$/, "") !== adapter
    || frontend.NEXT_PUBLIC_RECOURSE_ADAPTER_URL?.replace(/\/+$/, "") !== adapter) throw new Error("Adapter origin differs across the release");
  const frontendOrigin = backend.FRONTEND_ORIGIN?.replace(/\/+$/, "");
  if (!frontendOrigin || new URL(frontendOrigin).protocol !== "https:" || new URL(frontendOrigin).origin !== frontendOrigin) throw new Error("An explicit HTTPS frontend origin is required");
  return { chainId: RELEASE_CHAIN_ID, protocolVersion: PROTOCOL_VERSION, contractAddress: address, rpc, adapter, frontendOrigin, sourceSha256: expected.sourceSha256,
    backendConfigurationSource: backendDeployment.configurationSource, frontendConfigurationSource: frontendDeployment.configurationSource };
}

export async function verifyHostedRelease({ release, manifestHash, fetcher }) {
  async function getJson(url) {
    const response = await fetcher(url);
    if (!response.ok) throw new Error("Hosted release identity or health is unavailable");
    return response.json();
  }
  const [adapter, health, frontend] = await Promise.all([
    getJson(`${release.adapter}/agents`), getJson(`${release.adapter}/ready`), getJson(`${release.frontendOrigin}/api/deployment`),
  ]);
  for (const identity of [adapter, health, frontend]) {
    if (identity.chain_id !== release.chainId || identity.protocol_version !== release.protocolVersion
      || identity.contract_address?.toLowerCase() !== release.contractAddress || identity.manifest_hash !== manifestHash || identity.rpc_url !== release.rpc) {
      throw new Error("Hosted frontend/backend deployment identity or catalog is stale");
    }
  }
  if ([health, frontend].some(identity => identity.source_sha256 !== release.sourceSha256)) throw new Error("Hosted source identity differs from the release");
  if (frontend.adapter_url?.replace(/\/+$/, "") !== release.adapter || !health.ok || health.readiness !== "dependencies_verified"
    || !/^0x[0-9a-f]{40}$/i.test(adapter.provider ?? "")) throw new Error("Hosted provider, adapter URL, or configuration health is invalid");
  return { configurationConsistent: true, provider: adapter.provider, liveAcceptanceComplete: false };
}
