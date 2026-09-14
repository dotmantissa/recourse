# Pinned contract checks

Use Python 3.12, create `.venv`, install `requirements.txt`, and run:

```sh
npm run setup:contracts
npm run lint:contracts
npm run test:contracts
```

Setup downloads the official GenVM manager **v0.6.0-rc5 universal bundle**
(approximately 311 MB), verifies its pinned SHA-256, and extracts only the
contract's exact runner and standard library. Cached downloads remain local
under ignored `.runtime/`. The contract header is not rewritten. Subsequent
lint and test commands need no network or environment overrides.

The pinned `genvm-linter==0.11.0` imports the older `genlayer.py.get_schema`
module. The project wrapper replaces only its SDK loader, using the pinned
`genlayer-test` runner resolver and this SDK's `genlayer._internal.get_schema`.
AST safety checks, contract loading, storage validation, and schema reflection
still run through the linter; SDK validation is not skipped. No installed
package files are modified. Revisit this compatibility bridge when upgrading
the linter or contract runner, and update/check the bundle digest explicitly.

Direct tests simulate the SDK/WASI host. They do not establish live consensus,
transaction fees, availability, or actual network recipient balances. Those
require the separate integration and release acceptance checks.

The direct fixtures also bridge two pinned SDK/test-host differences: warped
timestamps update `genlayer.message.raw`, and `mock_json_prompt` supplies JSON
text at the host boundary (the test host otherwise parses it prematurely).
Neither bridge replaces contract logic or the SDK's response decoder. Payout
tests capture actual SDK `EmitInternalMessage` calls, not network transfers.
