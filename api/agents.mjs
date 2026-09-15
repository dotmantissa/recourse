import { fetchPublicUrl, publicUrl, readTextLimited } from "./http-safety.mjs";
import { validateAgentRequest } from "../agents/catalog.mjs";

function assertString(value, field, minimum, maximum) {
  const text = String(value ?? "").trim();
  if (text.length < minimum || text.length > maximum) {
    throw new Error(`${field} must be ${minimum}-${maximum} characters`);
  }
  return text;
}

function stripMarkup(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function words(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 4 && !new Set(["about", "after", "their", "there", "which", "would", "could", "these", "those", "where", "while"]).has(word));
}

export async function executeAgent(slug, payload, { fetchPublic = fetchPublicUrl } = {}) {
  validateAgentRequest(slug, payload);
  if (slug === "research-sources") {
    const query = assertString(payload.query, "query", 3, 240);
    const crossrefUrl = `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=5&select=title,URL,author,published,container-title`;
    const response = await fetchPublic(crossrefUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`source index returned ${response.status}`);
    const body = JSON.parse(await readTextLimited(response, 1_000_000));
    const items = Array.isArray(body?.message?.items) ? body.message.items : [];
    const sources = items.slice(0, 5).map((item) => {
      const title = Array.isArray(item.title) ? String(item.title[0] || "") : "";
      const authors = Array.isArray(item.author)
        ? item.author.slice(0, 3).map((author) => `${author.given || ""} ${author.family || ""}`.trim()).filter(Boolean).join(", ")
        : "";
      const year = item.published?.["date-parts"]?.[0]?.[0] || "n.d.";
      return {
        title: title || "Untitled source",
        url: String(item.URL || ""),
        citation: `${authors || "Unknown author"} (${year}). ${title || "Untitled source"}.`,
      };
    }).filter((item) => /^https?:\/\//.test(item.url));
    if (sources.length < 5) throw new Error("source index returned fewer than five usable sources");
    return { query, sources };
  }

  if (slug === "citation-validator") {
    const claim = assertString(payload.claim, "claim", 3, 1000);
    if (!Array.isArray(payload.sources) || payload.sources.length < 1 || payload.sources.length > 10) {
      throw new Error("sources must contain 1-10 URLs");
    }
    const sources = payload.sources.map((value) => publicUrl(value, "source"));
    const checks = await Promise.all(sources.map(async (url) => {
      try {
        const response = await fetchPublic(url, { headers: { Accept: "text/html,application/xhtml+xml" } }, 6000);
        const raw = await readTextLimited(response, 120_000);
        const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        return {
          url: url.toString(),
          reachable: response.ok,
          title: (stripMarkup(titleMatch?.[1] || "") || url.hostname).slice(0, 180),
          status: response.status,
        };
      } catch {
        return { url: url.toString(), reachable: false, title: "", status: 0 };
      }
    }));
    const reachable = checks.filter((item) => item.reachable).length;
    return { claim, checks, verdict: reachable === checks.length ? "all sources reachable" : `${reachable}/${checks.length} sources reachable` };
  }

  if (slug === "json-repair") {
    let normalized;
    try {
      normalized = typeof payload.document === "string" ? JSON.parse(payload.document) : payload.document;
    } catch {
      return { valid: false, normalized: null, missing_keys: [], error: "document is not valid JSON" };
    }
    if (normalized === null || typeof normalized !== "object") {
      return { valid: false, normalized, missing_keys: [], error: "document must be an object or array" };
    }
    const requiredKeys = Array.isArray(payload.required_keys)
      ? payload.required_keys.map((item) => assertString(item, "required_key", 1, 64)).slice(0, 32)
      : [];
    const target = Array.isArray(normalized) ? normalized[0] : normalized;
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      return { valid: false, normalized, missing_keys: requiredKeys, error: "document must contain an object to check" };
    }
    const missingKeys = requiredKeys.filter((key) => !Object.hasOwn(target, key));
    return { valid: missingKeys.length === 0, normalized, missing_keys: missingKeys };
  }

  if (slug === "code-policy") {
    const code = payload.code;
    const language = assertString(payload.language, "language", 2, 12).toLowerCase();
    if (!["javascript", "typescript", "python"].includes(language)) throw new Error("language must be javascript, typescript, or python");
    const rules = [
      ["eval", /\beval\s*\(/g, "high"],
      ["shell-exec", /\b(child_process|subprocess|os\.system|execSync)\b/g, "high"],
      ["secret-access", /\b(process\.env|os\.environ)\b/g, "medium"],
      ["network-call", /\b(fetch|axios|requests\.(get|post)|httpx\.)\b/g, "low"],
    ];
    const findings = [];
    for (const [rule, pattern, severity] of rules) {
      for (const match of code.matchAll(pattern)) {
        const line = code.slice(0, match.index).split("\n").length;
        findings.push({ rule, severity, line });
      }
    }
    const score = Math.max(0, 100 - findings.reduce((total, finding) => total + (finding.severity === "high" ? 25 : finding.severity === "medium" ? 10 : 3), 0));
    return { language, score, findings: findings.slice(0, 100) };
  }

  if (slug === "page-brief") {
    const url = publicUrl(payload.url, "url");
    const response = await fetchPublic(url, { headers: { Accept: "text/html,application/xhtml+xml,text/plain" } }, 8000);
    if (!response.ok) throw new Error(`page returned ${response.status}`);
    const raw = await readTextLimited(response, 1_000_000);
    const text = stripMarkup(raw);
    const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || url.hostname;
    const phraseCounts = new Map();
    for (const word of words(text)) phraseCounts.set(word, (phraseCounts.get(word) || 0) + 1);
    const keyPhrases = [...phraseCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([word]) => word);
    return { url: url.toString(), title: stripMarkup(title).slice(0, 180), excerpt: text.slice(0, 900), key_phrases: keyPhrases };
  }

  throw new Error("unknown agent capability");
}
