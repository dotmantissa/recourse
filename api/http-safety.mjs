import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { Agent } from "undici";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function parseId(value, field = "job_id") {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new HttpError(400, `${field} must be a positive numeric ID string (at most 20 digits)`);
  }
  return value;
}

export function parseObject(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, "request body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "request body must be a JSON object");
  }
  return value;
}

export function readBody(request, maxBytes = 100_000, timeoutMs = 10000) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    };
    const onError = (error) => {
      cleanup();
      request.pause();
      reject(error);
    };
    const onAborted = () => onError(new HttpError(400, "request body was interrupted"));
    const onData = (chunk) => {
      size += chunk.length;
      if (size > maxBytes) return onError(new HttpError(413, "payload too large"));
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolveBody(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(() => onError(new HttpError(408, "request body timed out")), timeoutMs);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
    if (Number(request.headers["content-length"]) > maxBytes) {
      onError(new HttpError(413, "payload too large"));
    }
  });
}

export function privateIp(address) {
  if (!isIP(address)) return true;
  const parsed = ipaddr.parse(address);
  const candidate = parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()
    ? parsed.toIPv4Address()
    : parsed;
  return candidate.range() !== "unicast";
}

export function publicUrl(value, field = "url") {
  if (!(value instanceof URL) && (typeof value !== "string" || value.length > 2048)) {
    throw new Error(`${field} must be a URL of at most 2048 characters`);
  }
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password
    || hostname === "localhost" || hostname.endsWith(".localhost")
    || hostname.endsWith(".local") || hostname.endsWith(".internal")
    || (url.port && !["80", "443"].includes(url.port))
    || (isIP(hostname) && privateIp(hostname))) {
    throw new Error(`${field} must resolve to a public host on port 80 or 443`);
  }
  return url;
}

export function withSignal(operation, signal) {
  return new Promise((resolveOperation, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(operation).then(resolveOperation, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
    if (signal.aborted) onAbort();
  });
}

async function resolvePublicUrl(value, field, resolveHost, signal) {
  signal.throwIfAborted();
  const url = publicUrl(value, field);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await withSignal(resolveHost(hostname, { all: true, verbatim: true }), signal);
  if (!addresses.length || addresses.some((entry) => privateIp(entry.address))) {
    throw new Error(`${field} must resolve to a public host`);
  }
  return { url, addresses };
}

export async function assertPublicUrl(value, field) {
  return (await resolvePublicUrl(value, field, lookup, AbortSignal.timeout(8000))).url;
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  return fetch(url, { ...options, signal });
}

export async function readTextLimited(response, maxBytes, signal) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const pending = reader.read();
      const { done, value } = await (signal ? withSignal(pending, signal) : pending);
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("remote response exceeded size limit");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export function createWorkLimiter(limit) {
  let active = 0;
  return async (operation) => {
    if (active >= limit) throw new HttpError(503, "service concurrency limit exceeded; retry later");
    active += 1;
    try {
      return await operation();
    } finally {
      active -= 1;
    }
  };
}

export function createPublicFetcher({ resolveHost = lookup, fetchResponse = fetch, dispatcherFactory = (options) => new Agent(options) } = {}) {
  const limitWork = createWorkLimiter(16);
  return (value, options = {}, timeoutMs = 8000, maxRedirects = 3) => limitWork(async () => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let current = value.toString();
    const headers = new Headers(options.headers);
    const method = (options.method || "GET").toUpperCase();
    if (!["GET", "HEAD"].includes(method)) throw new Error("public URL fetch only supports GET and HEAD");
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      const { url, addresses } = await resolvePublicUrl(current, "url", resolveHost, signal);
      const dispatcher = dispatcherFactory({ connect: {
        lookup(hostname, lookupOptions, callback) {
          if (hostname !== url.hostname) return callback(new Error("unexpected connection hostname"));
          const candidates = lookupOptions.family
            ? addresses.filter((entry) => entry.family === lookupOptions.family)
            : addresses;
          if (!candidates.length) return callback(new Error("no validated address for requested family"));
          if (lookupOptions.all) callback(null, candidates);
          else callback(null, candidates[0].address, candidates[0].family);
        },
      } });
      try {
        const response = await withSignal(fetchResponse(url.toString(), { ...options, method, headers, dispatcher, signal, redirect: "manual" }), signal);
        if (![301, 302, 303, 307, 308].includes(response.status)) {
          const body = await readTextLimited(response, 1_000_000, signal);
          const responseHeaders = new Headers(response.headers);
          responseHeaders.delete("content-encoding");
          responseHeaders.delete("content-length");
          return new Response(method === "HEAD" || [204, 205, 304].includes(response.status) ? null : body, {
            status: response.status,
            statusText: response.statusText,
            headers: responseHeaders,
          });
        }
        await withSignal(response.body?.cancel(), signal);
        const location = response.headers.get("location");
        if (!location) throw new Error("public URL returned a redirect without a location");
        if (redirect === maxRedirects) throw new Error("public URL exceeded redirect limit");
        const next = new URL(location, url);
        if (next.origin !== url.origin) {
          headers.delete("authorization");
          headers.delete("cookie");
          headers.delete("proxy-authorization");
        }
        current = next.toString();
      } finally {
        await dispatcher.destroy();
      }
    }
    throw new Error("public URL could not be fetched");
  });
}

export const fetchPublicUrl = createPublicFetcher();
