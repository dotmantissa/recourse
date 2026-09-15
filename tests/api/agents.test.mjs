import assert from "node:assert/strict";
import test from "node:test";
import Ajv from "ajv";
import manifest from "../../agents/manifest.json" with { type: "json" };
import fixtures from "../fixtures/services.json" with { type: "json" };
import { AGENT_DEFINITIONS, MANIFEST_HASH, hostedCapabilityMatches, validateAgentRequest } from "../../agents/catalog.mjs";
import { executeAgent } from "../../api/agents.mjs";

const fetchPublic = async (url) => {
  if (String(url).startsWith("https://api.crossref.org/works?")) {
    return Response.json({ message: { items: fixtures["research-sources"].output.sources.map((source) => ({
      title: [source.title], URL: source.url, author: [{ given: "A", family: "Researcher" }], published: { "date-parts": [[2026]] },
    })) } });
  }
  assert.equal(String(url), "https://example.com/page");
  return new Response("<title>Example</title><script>hidden</script><body>example consensus consensus</body>");
};

for (const agent of manifest.agents) {
  test(`${agent.slug} executes and enforces its complete nested output schema`, async () => {
    const fixture = fixtures[agent.slug];
    const output = await executeAgent(agent.slug, fixture.request, { fetchPublic });
    assert.deepEqual(output, fixture.output);
    const validate = new Ajv({ strict: true }).compile(agent.output_schema);
    assert.equal(validate(output), true, JSON.stringify(validate.errors));
    const altered = structuredClone(output);
    const target = fixture.invalid_path.slice(0, -1).reduce((value, key) => value[key], altered);
    target[fixture.invalid_path.at(-1)] = fixture.invalid_value;
    assert.equal(validate(altered), false);
    assert.equal(validate({ ...output, undeclared: true }), false);
  });

  test(`${agent.slug} rejects missing and undeclared inputs before execution`, async () => {
    for (const request of [{}, null, [], { ...fixtures[agent.slug].request, unexpected: true }]) {
      await assert.rejects(executeAgent(agent.slug, request, { fetchPublic: () => assert.fail("must not fetch") }), /input schema/);
    }
  });
}

test("hosted catalog and contract registration share exact schemas and terms", () => {
  assert.match(MANIFEST_HASH, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(AGENT_DEFINITIONS), manifest.agents.map((agent) => agent.slug));
  for (const agent of manifest.agents) {
    const capability = { ...agent, output_schema: JSON.stringify(agent.output_schema) };
    assert.equal(hostedCapabilityMatches(agent.slug, capability), true);
    for (const update of [{ output_schema: "{}" }, { terms: "unsupported promises" }, { deadline_seconds: 3600 }, { malformed_refund_bps: 0 }]) {
      assert.equal(hostedCapabilityMatches(agent.slug, { ...capability, ...update }), false);
    }
  }
  assert.equal(hostedCapabilityMatches("__proto__", {}), false);
});

test("required-key checking never accepts inherited keys or repairs malformed JSON", async () => {
  const inherited = await executeAgent("json-repair", { document: "{}", required_keys: ["toString", "constructor"] });
  assert.deepEqual(inherited.missing_keys, ["toString", "constructor"]);
  assert.equal(inherited.valid, false);
  for (const document of ["broken JSON", [], [null], [1], [[{}]], null]) {
    const result = await executeAgent("json-repair", { document });
    assert.equal(result.valid, false);
    assert.equal(typeof result.error, "string");
  }
  assert.throws(() => validateAgentRequest("json-repair", { document: {}, required_keys: Array(33).fill("key") }), /input schema/);
});

test("network failures are reported honestly rather than fabricated as usable output", async () => {
  await assert.rejects(executeAgent("research-sources", fixtures["research-sources"].request, {
    fetchPublic: async () => Response.json({ message: { items: [] } }),
  }), /fewer than five/);
  await assert.rejects(executeAgent("page-brief", fixtures["page-brief"].request, {
    fetchPublic: async () => new Response("unavailable", { status: 503 }),
  }), /503/);
  const result = await executeAgent("citation-validator", fixtures["citation-validator"].request, {
    fetchPublic: async () => { throw new Error("unavailable"); },
  });
  assert.equal(result.checks[0].reachable, false);
  assert.equal(result.checks[0].status, 0);
  assert.equal(result.verdict, "0/1 sources reachable");
});
