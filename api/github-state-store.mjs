import { HttpError, parseId, readTextLimited } from "./http-safety.mjs";

export function createGithubStateStore({ request, repository, branch, scope, encode, decode }) {
  const base = `/repos/${repository}/contents/executions/${scope}`;
  const pathFor = (key) => `${base}/${parseId(key)}.json`;

  async function read(key) {
    const response = await request(`${pathFor(key)}?ref=${encodeURIComponent(branch)}`);
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(503, "durable execution storage is unavailable");
    }
    const body = JSON.parse(await readTextLimited(response, 2_000_000));
    if (body.encoding !== "base64" || typeof body.content !== "string" || typeof body.sha !== "string") throw new Error("invalid execution storage response");
    return { version: body.sha, value: decode(JSON.parse(Buffer.from(body.content, "base64").toString("utf8"))) };
  }

  async function compareAndSet(key, version, value) {
    const response = await request(pathFor(key), {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `Advance Recourse execution ${scope}/${key}`, branch,
        content: Buffer.from(JSON.stringify(encode(value))).toString("base64"), ...(version ? { sha: version } : {}) }),
    });
    if ([409, 422].includes(response.status)) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(503, "durable execution checkpoint failed");
    }
    const body = JSON.parse(await readTextLimited(response, 100_000));
    if (typeof body.content?.sha !== "string") throw new Error("execution checkpoint has no revision");
    return { version: body.content.sha, value };
  }

  return { read, compareAndSet };
}
