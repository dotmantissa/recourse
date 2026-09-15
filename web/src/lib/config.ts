import releaseManifest from "../../../deploy/release.json";
import { selectReleaseDeployment } from "../../../sdk/release-config.mjs";

const deployment = selectReleaseDeployment(releaseManifest, { mode: process.env.NEXT_PUBLIC_RECOURSE_DEPLOYMENT_MODE,
  contractAddress: process.env.NEXT_PUBLIC_RECOURSE_CONTRACT_ADDRESS,
  chainId: process.env.NEXT_PUBLIC_RECOURSE_CHAIN_ID, rpc: process.env.NEXT_PUBLIC_RECOURSE_RPC });
export const RPC_URL = deployment.rpc;
export const CHAIN_ID = deployment.chainId;
export const CONTRACT_ADDRESS = deployment.contractAddress;
export const CONFIGURATION_SOURCE = deployment.configurationSource;
export const CONTRACT_SOURCE_SHA256 = deployment.sourceSha256;
export const EXPLORER_URL = "https://explorer-studio-dev.genlayer.com/";
export const MONITOR_ADDRESS = process.env.NEXT_PUBLIC_RECOURSE_MONITOR_ADDRESS ?? "";
export const ADAPTER_URL = process.env.NEXT_PUBLIC_RECOURSE_ADAPTER_URL ?? "";
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function shortAddress(value: string) {
  return value ? `${value.slice(0, 6)}...${value.slice(-4)}` : "Not connected";
}

export function formatGen(wei: number | string | bigint) {
  const value = typeof wei === "bigint" ? wei : BigInt(wei);
  const whole = value / 1000000000000000000n;
  const fraction = (value % 1000000000000000000n).toString().padStart(18, "0").slice(0, 4);
  return `${whole}.${fraction} GEN`;
}

export function parseGen(value: string) {
  const clean = value.trim();
  if (!/^(?:\d+)(?:\.\d{0,18})?$/.test(clean)) throw new Error("Enter a valid GEN amount.");
  const [whole, fraction = ""] = clean.split(".");
  return BigInt(whole) * 1000000000000000000n + BigInt(fraction.padEnd(18, "0") || "0");
}

export function formatDate(value: number | string) {
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
