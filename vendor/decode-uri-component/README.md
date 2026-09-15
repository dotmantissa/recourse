# CommonJS compatibility build

This is the MIT-licensed `decode-uri-component` **0.5.0** implementation from
the npm registry. Its linear-time malformed UTF-8 decoder fixes the advisory
affecting versions through 0.4.2. The upstream license is retained.

The only runtime change is replacing the default ESM export with
`module.exports`; TypeScript removes comments and formats the JavaScript. This
keeps the existing CommonJS `query-string@7` dependency working without downgrading
Privy or replacing its wallet stack. No decoding logic is changed.

`web/tests/dependencies.test.mjs` covers real CommonJS consumers, valid/malformed
Unicode, and an adversarial long input. Remove this compatibility copy when the
wallet stack supports upstream's ESM-only version directly.
