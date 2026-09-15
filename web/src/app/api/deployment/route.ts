import { ADAPTER_URL, CHAIN_ID, CONTRACT_ADDRESS, RPC_URL, CONFIGURATION_SOURCE, CONTRACT_SOURCE_SHA256 } from "@/lib/config";
import manifest from "../../../../../agents/manifest.json";
import { digest } from "../../../../../sdk/protocol.mjs";

export function GET() {
  return Response.json({ chain_id: CHAIN_ID, protocol_version: 2, contract_address: CONTRACT_ADDRESS,
    configuration_source: CONFIGURATION_SOURCE, source_sha256: CONTRACT_SOURCE_SHA256,
    adapter_url: ADAPTER_URL, rpc_url: RPC_URL, manifest_hash: digest(manifest) }, { headers: { "Cache-Control": "no-store" } });
}
