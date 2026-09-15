function validateTarget(target) {
  if (Number(target.chainId) !== 61997 || !/^0x[0-9a-f]{40}$/i.test(target.contractAddress ?? "")
    || /^0x0{40}$/i.test(target.contractAddress)) throw new Error("Release requires an explicit Studio Dev contract");
  const rpc = new URL(target.rpc);
  if (rpc.protocol !== "https:" || rpc.username || rpc.password || rpc.hash) throw new Error("Release RPC must be an HTTPS URL without credentials");
}

export function selectReleaseDeployment(release, overrides = {}) {
  if (release?.schemaVersion !== 1 || release.protocolVersion !== 2 || !/^[0-9a-f]{64}$/.test(release.sourceSha256 ?? "")) {
    throw new Error("Invalid protocol release manifest");
  }
  validateTarget(release);
  const mode = overrides.mode ?? "release";
  if (!["release", "environment"].includes(mode)) throw new Error("Deployment mode must be release or environment");
  const selected = mode === "environment"
    ? { ...release, contractAddress: overrides.contractAddress, rpc: overrides.rpc, chainId: Number(overrides.chainId) }
    : { ...release };
  validateTarget(selected);
  return { ...selected, contractAddress: selected.contractAddress.toLowerCase(), configurationSource: mode === "release" ? "release_manifest" : "explicit_environment" };
}
