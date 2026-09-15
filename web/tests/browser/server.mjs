import { build } from "esbuild";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bundle = await build({
  absWorkingDir: root, entryPoints: ["tests/browser/entry.tsx"], bundle: true, write: false,
  format: "iife", jsx: "automatic", tsconfig: "tsconfig.json",
  define: { "process.env": "{}", "process.env.NODE_ENV": '"test"', "process.env.NEXT_PUBLIC_PRIVY_APP_ID": '"browser-fixture"',
    "process.env.NEXT_PUBLIC_RECOURSE_CONTRACT_ADDRESS": '"0x1111111111111111111111111111111111111111"' },
  plugins: [{ name: "test-only-transports", setup(builder) {
    builder.onResolve({ filter: /^@privy-io\/react-auth$/ }, () => ({ path: `${root}tests/browser/privy.ts` }));
    builder.onResolve({ filter: /^@\/lib\/genlayer$/ }, () => ({ path: `${root}tests/browser/transport.ts` }));
  } }],
});
const css = await readFile(new URL("../../src/app/globals.css", import.meta.url), "utf8");
createServer((request, response) => {
  if (request.url === "/app.js") { response.setHeader("content-type", "text/javascript"); response.end(bundle.outputFiles[0].text); }
  else if (request.url === "/style.css") { response.setHeader("content-type", "text/css"); response.end(css); }
  else { response.setHeader("content-type", "text/html"); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>'); }
}).listen(4173, "127.0.0.1");
