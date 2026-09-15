import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const decode = require("decode-uri-component");

test("patched URI decoding preserves CommonJS wallet query-string compatibility", () => {
  const queryString = require("query-string");
  assert.equal(typeof decode, "function");
  assert.equal(decode("hello%20world"), "hello world");
  assert.equal(decode("%F0%9F%92%A9"), "💩");
  assert.equal(decode("%C3%A5%ZZ"), "å%ZZ");
  assert.equal(queryString.parse("label=hello%20world").label, "hello world");
  assert.equal(queryString.parseUrl("https://example.com/?label=%C3%A5").query.label, "å");
});

test("malformed UTF-8 cannot trigger exponential decoder work", { timeout: 2000 }, () => {
  const input = "%FE".repeat(20000);
  assert.equal(decode(input), input);
  assert.throws(() => decode(null), TypeError);
});

test("patched uuid retains CommonJS generation and validation for wallet dependencies", () => {
  const uuid = require("uuid");
  assert.equal(uuid.validate(uuid.v4()), true);
  assert.equal(uuid.version(uuid.v4()), 4);
  assert.throws(() => uuid.v5("recourse", uuid.v5.DNS, new Uint8Array(1)), RangeError);
});
