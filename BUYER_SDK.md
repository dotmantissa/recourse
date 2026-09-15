# Bounded autonomous buyer

The Node SDK `sdk/buyer.mjs` funds an ordered allowlist of capabilities, initiates
each provider once, verifies committed public evidence, settles objective results,
opens/resolves quality disputes, and invokes permissionless recovery when the
contract's delivery/evidence/adjudication deadlines expire. It tries the next
authorized capability **only after the previous job is settled** (or funding
definitively fails). It does not promise semantic accuracy or a refund.

## Plan and CLI

Create a local JSON plan with your actual protocol-v2 deployment and buyer:

```json
{
  "runId": "research-001",
  "chainId": 61997,
  "contractAddress": "0xYOUR_PROTOCOL_V2_CONTRACT",
  "buyer": "0xYOUR_BUYER_ADDRESS",
  "capabilityIds": ["1", "2"],
  "requestLabel": "Find sources for the requested topic",
  "request": { "query": "verifiable agent service execution" },
  "publicEvidence": true,
  "maxSpendWei": "20000000000000000",
  "maxFeeWei": "3000000000000000000",
  "maxFeePerTransactionWei": "500000000000000000",
  "maxTransactions": 12,
  "qualityChecks": []
}
```

Addresses above are placeholders, not runnable defaults. Capability IDs and
budgets are explicit authorization, not recommended fees. At most five distinct
capabilities and 30 writes are allowed. Amounts must be decimal **strings** in wei.

```sh
npm run buyer -- /path/to/plan.json
# Only after reviewing the plan and configuring BUYER_PRIVATE_KEY locally:
npm run buyer -- /path/to/plan.json --run
# Or advance one checkpoint for an external scheduler:
npm run buyer -- /path/to/plan.json --run --once
```

Without `--run`, the CLI validates only: no RPC, journal creation, provider request,
or chain write. The signer must match `buyer`; the CLI verifies chain 61997 and
required protocol-v2 methods. All contract reads explicitly select finalized state;
replacement never relies on the SDK's default nonfinal snapshot. Injected SDK
transports must provide the same finalized-state guarantee. Finality delays may
consume the contract's challenge window, so live timing remains a release gate.
It never uses a demo key or the provider/deployer key as an implicit buyer.
CLI runs poll every 15 seconds and stop within a
one-hour scheduling window (in-flight SDK/network calls can extend it). Resume
the **same** plan/run ID to retain budgets and pending transactions.

## Safety and recovery

- Gross funded value and reserved protocol fee budgets accumulate across all
  attempts. Refunds do not replenish authorization. Wallet/network overhead is
  additional. The caps are per journal, not a global wallet spending policy.
- Writes are checkpointed before submission. Known hashes are polled, never
  resent. A crash/error before the hash is saved requires operator reconciliation;
  the engine does not guess whether a write was broadcast.
- Provider execution is also checkpointed before POST and never automatically
  repeated, including after a lost response. The buyer subsequently reads the
  contract's cached evidence. A request lost before reaching the provider may
  therefore end in timeout recovery rather than a retry.
- The CLI pins DNS for provider POSTs, bounds response/body size and deadlines,
  and refuses to replay POST redirects. No wallet private key or authentication
  token is forwarded to the provider.
- `.runtime/buyer/` holds an AES-GCM encrypted, atomically replaced journal and a
  local mode-0600 key. Back up both securely. Journal authentication errors fail
  closed. The default paths are git-ignored. All actual request/output evidence
  still becomes public; journal encryption does not make it confidential.
- A process lock prevents concurrent runners on the same journal. A crashed
  process may leave its `.lock` directory. Verify the process has stopped and
  inspect/reconcile the journal before manually removing that lock. Do not
  delete the journal, change the run ID, or create a new budget to bypass an
  uncertain write.
- Each action has at most two attempts and consumes the total write/fee caps.
  If a cap is exhausted while escrow remains open, a separate authorized operator
  or funded worker must finish recovery. The engine cannot guarantee liveness
  without available RPC, storage, validators, and sufficient fees.

## Acceptance checks and embedding

The SDK verifies the provider signature and domain-bound `recourse-request-v3`
request/output commitments against
the funded job, independently applies the registered JSON schema, and evaluates
optional bounded field-equality checks, for example:

```json
[{ "path": ["verdict"], "equals": "supported" }]
```

Checks should reflect the committed request and provider's advertised terms. A
failed check opens a quality dispute while its challenge window is still open;
validators independently decide compensation. Missing a challenge window does
not grant a retroactive refund. An empty check list accepts structurally valid,
timely success output, **not independently verified semantic correctness**.

`createBuyerWorkflow({ plan, journal, transport }).step()` advances a bounded
checkpoint and returns status/budgets/current job/attempt summaries plus the
verified selected output on completion. Inject a journal with `read`, `write`,
and `withLock`; inject transport methods `read`, `estimate`, `send`, `transaction`,
and `execute`. `scripts/buyer.mjs` is the concrete GenLayer integration. Read-only
transport errors preserve the journal; a later invocation can resume. The CLI
reports output availability rather than logging request/output bodies.

This workflow is covered by local fault-injection tests. Multi-validator,
independent-provider, live balance, and production acceptance are separate
release gates; running unit tests does not satisfy them.
