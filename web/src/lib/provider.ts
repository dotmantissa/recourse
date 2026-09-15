type RegistrationTerms = {
  name: string;
  terms: string;
  deadline: string;
  schema: string;
  timeout: string;
  malformed: string;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function validateRegistrationEndpoint(endpoint: string, wallet: string, adapter: string, fetcher: typeof fetch = fetch, registration?: RegistrationTerms) {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("Use an HTTPS provider endpoint without credentials or fragments.");
  if (!adapter || url.origin !== new URL(adapter).origin) return;
  const response = await fetcher(`${new URL(adapter).origin}/agents`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("The hosted provider manifest is unavailable.");
  const manifest = await response.json();
  if (String(manifest.provider).toLowerCase() !== wallet.toLowerCase()
    || !Array.isArray(manifest.agents) || !manifest.agents.some((agent: { execute_url?: string }) => agent.execute_url === url.href)) {
    throw new Error("This hosted endpoint belongs to another provider. Deploy your own adapter and register its signing wallet.");
  }
  if (registration) {
    const definition = manifest.agents.find((agent: { execute_url?: string }) => agent.execute_url === url.href);
    if (registration.name.trim() !== definition.name || registration.terms.trim() !== definition.terms
      || Number(registration.deadline) !== definition.deadline_seconds
      || Number(registration.timeout) * 100 !== definition.timeout_refund_bps
      || Number(registration.malformed) * 100 !== definition.malformed_refund_bps
      || canonical(JSON.parse(registration.schema)) !== canonical(definition.output_schema)) {
      throw new Error("Use the exact hosted service name, terms, deadline, refunds, and schema published in /agents.");
    }
  }
}
