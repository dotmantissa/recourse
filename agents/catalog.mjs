import Ajv from "ajv";
import manifest from "./manifest.json" with { type: "json" };
import { canonicalJson, digest } from "../sdk/protocol.mjs";

const validator = new Ajv({ strict: true, ownProperties: true });
const requests = new Map();

if (manifest.version !== 2 || manifest.chain_id !== 61997 || !Array.isArray(manifest.agents) || manifest.agents.length !== 5) {
  throw new Error("Invalid hosted capability manifest");
}

export const AGENT_DEFINITIONS = Object.fromEntries(manifest.agents.map((agent) => {
  if (!/^[a-z]+(?:-[a-z]+)*$/.test(agent.slug) || requests.has(agent.slug)) throw new Error("Invalid or duplicate hosted capability slug");
  requests.set(agent.slug, validator.compile(agent.input_schema));
  validator.compile(agent.output_schema);
  return [agent.slug, { ...agent, method: "POST", endpoint: `/agents/${agent.slug}/execute` }];
}));

export const MANIFEST_HASH = digest(manifest);

export function validateAgentRequest(slug, payload) {
  const validate = requests.get(slug);
  if (!validate || !validate(payload)) throw new Error("Request does not match the published capability input schema");
}

export function hostedCapabilityMatches(slug, capability) {
  const agent = AGENT_DEFINITIONS[slug];
  if (!Object.hasOwn(AGENT_DEFINITIONS, slug) || !capability) return false;
  try {
    return capability.name === agent.name && capability.terms === agent.terms
      && Number(capability.deadline_seconds) === agent.deadline_seconds
      && Number(capability.timeout_refund_bps) === agent.timeout_refund_bps
      && Number(capability.malformed_refund_bps) === agent.malformed_refund_bps
      && canonicalJson(JSON.parse(capability.output_schema)) === canonicalJson(agent.output_schema);
  } catch {
    return false;
  }
}
