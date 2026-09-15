export async function assertPurchaseReadiness(
  expected: { adapter: string; chainId: number; contractAddress: string; rpc: string; manifestHash: string },
  fetcher: typeof fetch = fetch,
) {
  const unavailable = "Purchases are paused until the adapter and contract pass the coordinated release checks. Existing escrow recovery is not disabled.";
  try {
    if (!expected.adapter || !expected.contractAddress) throw new Error(unavailable);
    const response = await fetcher(`${expected.adapter.replace(/\/+$/, "")}/ready`, { cache: "no-store", signal: AbortSignal.timeout(25_000) });
    if (!response.ok) throw new Error(unavailable);
    const identity = await response.json();
    if (identity.ok !== true || identity.readiness !== "dependencies_verified" || identity.protocol_version !== 2
      || identity.chain_id !== expected.chainId || identity.contract_address?.toLowerCase() !== expected.contractAddress.toLowerCase()
      || identity.rpc_url !== expected.rpc || identity.manifest_hash !== expected.manifestHash) throw new Error(unavailable);
  } catch { throw new Error(unavailable); }
}
