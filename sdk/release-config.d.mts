export type ReleaseManifest = {
  schemaVersion: number;
  protocolVersion: number;
  chainId: number;
  contractAddress: string;
  rpc: string;
  sourceSha256: string;
  deploymentTransaction?: string;
};
export function selectReleaseDeployment(release: ReleaseManifest, overrides?: {
  mode?: string;
  contractAddress?: string;
  rpc?: string;
  chainId?: number | string;
}): ReleaseManifest & { configurationSource: "release_manifest" | "explicit_environment" };
