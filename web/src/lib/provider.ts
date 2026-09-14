export async function validateRegistrationEndpoint(endpoint: string, wallet: string, adapter: string, fetcher: typeof fetch = fetch) {
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
}
