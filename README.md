# Recourse

Recourse is a request-level native-GEN escrow and recourse protocol for agents
buying services from other agents or APIs. Its HTTP handshake is custom, not
an interoperable x402 payment scheme.

This checkout targets **protocol v2**, requiring a coordinated fresh contract,
adapter and browser release. The historical deployment is not migrated merely
by building this checkout. See `PROTOCOL.md` for lifecycle and disclosure rules
and `CONTRACT_TOOLCHAIN.md` for reproducible pinned contract checks. Legacy
operational/demo smoke scripts still require migration before release use.

An agent can pay for a single capability with explicit terms. The provider
returns a signed execution receipt. A public evidence packet lets GenLayer
verify request/output commitments and output schema, and apply timing/status
rules to provider-signed measurements. These measurements are not independent
network observations. Valid
jobs settle to the provider; breached jobs refund the buyer; semantic disputes
are adjudicated by GenLayer and settle from the same escrow.

## MVP workflow

1. A provider registers an agent or API capability with a public endpoint,
   request terms, deadline, required output schema, compensation rules, and
   collateral.
2. A buyer explicitly consents to public input/output evidence and funds the
   exact price into escrow. Never submit secrets or personal data.
3. The provider accepts the job, then executes the structured request and
   provider publishes a signed execution receipt containing the request hash,
   output hash, response status, and completion timestamp.
4. The adapter encrypts private delivery checkpoints. Anyone can publish the
   complete public evidence packet, which the contract verifies and caches.
   Published request/output content is not confidential.
5. The buyer opens **My escrows** to retrieve the result, inspect evidence, and
   settle an objectively valid job or open a dispute.
6. GenLayer independently verifies the evidence and, for quality disputes,
   compares stable decision fields from independent validator runs.
7. The escrow pays the provider or buyer and updates provider reputation.

The built-in Source Scout capability queries Crossref for five scholarly
citations in JSON. It does not independently establish that a citation supports
the buyer's claim. Its default terms are:

- price: configured onchain per capability
- deadline: 30 seconds
- required fields: `query`, `sources`
- valid response: 100% provider payment
- timeout: 100% buyer refund
- malformed response: 75% buyer refund
- disputed quality: GenLayer adjudication

## GenLayer boundary

The browser and HTTP adapter own authentication, request construction, native
GEN escrow-intent checks, evidence storage, and presentation. The intelligent contract
owns the capability terms, escrow, receipt/evidence commitments, dispute
decision, settlement effect, and reputation record. Validators fetch the
public evidence themselves; no browser-provided verdict is trusted.

## Studio Next / Studio Dev

This project targets the Studio Next preview environment:

- browser: `https://studio-next.genlayer.com/run-debug?tutorial=1`
- canonical RPC: `https://studio-dev.genlayer.com/api`
- chain ID: `61997`
- explorer: `https://explorer-studio-dev.genlayer.com/`

The stable `studionet` network is intentionally not used. Studio Next is a
release-candidate environment and may reset. Deployment scripts fail closed if
the connected chain is not `61997`.

The contract uses the Studio Next template's pinned GenVM runner dependency. It stores structured state
as canonical JSON strings inside GenLayer `TreeMap` and `DynArray` fields.
Objective evidence is normalized with `strict_eq`; semantic disputes use
`run_nondet` and compare only stable fields:

- `decision`
- `refund_bps`
- `rule_ids`

## Local setup

Use Python 3.12 and Node 20.18.1+ (required by the HTTP transport).

```bash
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm ci
npm --prefix web ci
npm run setup:contracts
```

### Adapter and RPC safety checks

Run `npm run test:api` and `npm --prefix web test` for offline HTTP, egress,
storage-error, and RPC regression coverage. Both are included in `npm run verify`.
`npm run verify` also includes pinned-contract multi-validator simulation. Install
Chromium with `npm --prefix web exec -- playwright install chromium`, then run
`npm run verify:acceptance` for the desktop/mobile browser regression suite.
See `AUDIT-REMEDIATION.md` for implemented fixes and `RELEASE.md` for the separate
live acceptance gates. A paused historical frontend is not an activated protocol upgrade.
The RPC tests transpile the actual route using the installed TypeScript compiler;
they do not contact Studio or require credentials.

The adapter accepts JSON objects and canonical positive numeric ID strings (up to
20 digits). Request bodies are capped at 100 KB with a 10-second read deadline.
Public-page fetches validate every DNS answer and redirect, connect only to those
validated addresses, allow ports 80/443, and bound the decompressed body to 1 MB.
Their total timeout includes DNS, redirects, and body consumption.

Per adapter process, at most 64 HTTP handlers, 8 workers, and 16 public-page
fetches run concurrently. Duplicate execution requests recover the same durable job; exhausted
capacity returns `503`; the socket-IP limit is 240 requests/minute (`429`). Behind a
proxy, socket-IP limits may be shared by multiple users; forwarded client-IP headers
are not trusted. Rate/concurrency limits are per-process; use deployment-level
rate limits as well. Provider execution claims are durable, as described below.

The browser RPC proxy allows only the listed wallet/Studio methods, batches of at
most 10, 256 KB requests, and 4 MB responses. Each instance allows 32 concurrent
requests and 120 requests/minute per Vercel-supplied client IP (a shared fallback
outside Vercel). Body reads and upstream responses have 10/25-second deadlines.

`GET /` is liveness; `GET /health` returns `503` unless local storage is readable
and writable and signing, public URL, monitor, Privy, GitHub, and result-encryption
configuration are present. This checks local readiness, not remote credential
validity or chain availability. Storage read errors fail closed instead of being
treated as absent results. Evidence CLI writes reject path-like IDs and never
overwrite an existing evidence file. Contract lifecycle and committed-output
adjudication remain separate audit work.

### Durable execution and recovery

Execution requests are encrypted and checkpointed in GitHub before returning
`202`. GitHub content revisions provide compare-and-set claims across adapter
processes. The worker advances `queued → executing → executed → delivering →
delivered`; input and output checkpoints use the deployment-scoped encryption key.
The browser polls the same request while waiting, and a background scanner discovers
persisted jobs after a process restart. Repeated requests never authorize a second
execution of the same funded commitment.

Delivery publication is retryable independently of execution, with eight automatic
attempts and thirty-minute worker leases. An interrupted or failed execution is
marked `indeterminate`, never blindly executed again: the buyer must use bounded
onchain recovery instead. A stopped/sleeping host cannot advance the queue until
it resumes. Keep the adapter running for autonomous progress. Transaction receipt
publication is reconciled against onchain state; this is not a promise that a
failed RPC response can never incur an additional transaction fee.

### Deployment isolation and result verification

The `evidence` Git branch is the adapter's durable data store, not a feature or
release branch. It retains public evidence packets plus encrypted results and
execution/recovery checkpoints. `main` contains application code. Do not merge,
force-push, or delete `evidence` during a release: historical evidence URLs and
pending execution recovery depend on its records. Never store plaintext secrets
or private requests there.

Evidence and encrypted results are stored under `<chain-id>-<contract-address>/`.
New evidence URLs include that scope. Historical unscoped evidence URLs remain
read-only and continue to address the original files; they never resolve to a new
deployment's job with the same numeric ID. AES-GCM authenticates the deployment
scope as additional data. Existing unscoped ciphertext is retained, not silently
reassigned to another contract. A clean contract release must use its own scope.

Result access signatures bind the deployment, job, request hash, buyer wallet,
provider origin, and an expiry of at most five minutes. The browser retrieves
results from the registered provider's origin and never forwards its Privy token
to an unrelated provider. Providers implementing this recovery route must enforce
the scoped wallet signature; the hosted adapter additionally requires Privy.

`sdk/protocol.mjs` supplies the shared access-message and delivery-verification
helpers. The browser recomputes the output and receipt hashes, checks job/provider
identity, and verifies the provider signature before rendering a result. This
proves authenticity and integrity, not semantic correctness. Request inputs and
nonces are wallet/deployment-scoped in tab session storage, survive reloads in that
tab, and are cleared on logout or wallet change. They are not saved in persistent
local storage. Save recovery material separately if it must survive closing the tab.

Copy `.env.example` to `.env` and keep the deployment key outside Git.

```bash
npm run lint:contracts
npm run test
npm run typecheck
npm run build
```

## Deployment

The deployment script defaults to an offline plan. Execution requires an explicit
fee cap and `--run`; it verifies chain ID `61997`, exact deployed source and all
current contract methods, and finalized registry counts. See `RELEASE.md` before
pushing or switching a live environment.

```bash
npm run deploy:studio-next
# Configure DEPLOYER_KEY and DEPLOYMENT_MAX_FEE_WEI locally before authorizing:
npm run deploy:studio-next -- --run --promote
npm run verify:studio-next
npm run preflight:release
```

Never place a private key in source control or in a `NEXT_PUBLIC_*` variable.

Backend and frontend select the verified `deploy/release.json` deployment by
default, ignoring stale cloud address variables. `--promote` writes this public
manifest only after source/schema/finality verification. See `RELEASE.md` for
explicit preview environment overrides and coordinated production rollout.

## Operational checks

`smoke:studio-dev` and `verify:studio-next` are read-only source/schema/finalized
state checks, not payout or consensus acceptance tests. The old synthetic
`demo:studio-next` writer is retired and exits without networking or signing.
`smoke:buyer-flow` now forwards to the explicit plan-based buyer CLI; it no longer
uses a fixed capability ID, legacy commitments, or a demo private key.
Intentional failures belong only in an isolated integration environment.

## Browser transaction safety

Every contract write shows the value, protocol fee budget, combined budget and
internal payout-recipient count before opening the wallet. Quotes expire after
two minutes. Network/wallet costs may be additional; unsuccessful execution can
still incur fees and escrow refunds do not reimburse them.

Before submission, the browser saves an intent in local storage scoped to the
chain, contract and wallet. It then saves the returned transaction ID before
polling. Only public operation metadata is persisted here, not request bodies,
nonces, keys or raw calldata. Web Locks prevent concurrent writes from tabs in
the same browser profile. A pending intent blocks further app writes for that
scope; this is not a lock on another browser, device, or wallet application.

After a timeout/reload, use **Check finality** to read the original transaction,
not send another one. Polling is bounded to six status reads per check. The app
checks the transaction's sender/recipient and waits for finality, not merely
acceptance. Definite wallet rejection and terminal failure are distinguished
from unknown broadcast outcomes.

If the browser stops after broadcast but before saving the returned ID, the
intent stays blocked. Check wallet/explorer history and retain any transaction
ID; do not retry uncertain writes. The manual clear control is only for an
intent you have verified was **never broadcast**; it does not cancel a chain
transaction. Corrupt or unavailable local storage fails closed. Recovery of
known IDs is automatic/read-only; no-ID broadcast gaps still require operator
reconciliation. Pending public metadata deliberately survives logout; private
request inputs do not.

## Live test agents

Provider-owned listings expose **Manage** controls for collateral top-up,
available-collateral withdrawal, and pause/resume. Reserved collateral cannot
be withdrawn. Registration starts with a blank provider endpoint: the hosted
adapter can only serve its configured signer, not any wallet that registers its
URL. Independent providers must deploy/configure their own endpoint and signer.
The browser checks ownership against the hosted `/agents` manifest before
registration; the contract still enforces provider authorization on writes.

The browser loads at most 50 recent records per registry and provides explicit
older-history loading. Browsing history pauses automatic refresh; manual
refresh returns to recent records. It shows acceptance, receipt-deadline
timeouts, permissionless full-refund recovery, and the buyer challenge cutoff.

The adapter exposes five bounded service agents. They use real public inputs
and return real results; they are not seeded or mocked responses:

- `research-sources`: returns five Crossref search records, not verified claim support.
- `citation-validator`: reports URL reachability and titles, not citation entailment.
- `json-repair`: parses JSON and checks object keys; it does not repair JSON or validate arbitrary schemas.
- `code-policy`: reports four regex patterns and their declared score, not a security verdict.
- `page-brief`: returns a title, text prefix, and frequent words, not an AI summary.

`agents/manifest.json` is the single definition of service names, limitations,
terms, input schemas, nested output schemas, deadlines, and refund policies.
The API publishes these definitions and their digest at `/agents`. It rejects
invalid inputs and incompatible hosted listing terms before accepting work.
Contract settlement independently enforces nested output schemas; provider
assertions are not sufficient. Offline tests execute all five implementations
with mocked upstream HTTP and exercise valid/malformed onchain settlement logic.
These tests do not demonstrate live upstream availability or recipient payments.

Registration defaults to an offline plan using the same release manifest.
Configure `AGENT_SIGNING_KEY`, `RECOURSE_ADAPTER_URL`, price/collateral, and an explicit
`REGISTRATION_MAX_FEE_WEI`, then inspect the plan before adding `--run`:

```bash
npm run register:agents
npm run register:agents -- --run
```

Registration checks the hosted signer, deployment, and manifest hash, scans
finalized capability pages, and refuses conflicting listings or excessive fees.
It holds a local lock under `.runtime/registrations/` through the complete run.
An interrupted/failed run leaves that lock: reconcile any submitted transaction
and finalized listings before manually removing it. It never silently retries
an uncertain registration. Fees may total five times the per-registration cap;
the plan shows the maximum total collateral separately.

The opt-in autonomous buyer CLI and SDK are documented in `BUYER_SDK.md`.
They enforce an explicit capability allowlist, gross spending/fee caps, public
evidence consent, finalized settlement, and encrypted restart checkpoints.
Use `npm run buyer -- plan.json` for offline validation before authorizing
execution with `--run`. Live multi-validator and payout acceptance remain open.

An autonomous buyer uses its own Studio Next signer. Privy is the
embedded-wallet and authentication layer for the browser app; it is not a
server-side agent credential. The buyer reads `get_capabilities`, creates the
exact request and a fresh nonce, computes the domain-bound `recourse-request-v3` SHA-256
commitment, signs `create_job` with the capability's exact `price_wei`, and
waits for the resulting job to be readable before executing it.

The browser buyer flow is authorized by the user's Privy embedded wallet. The
`smoke:buyer-flow` alias uses the buyer plan and `BUYER_PRIVATE_KEY`; the
provider signer is the adapter's server-side `AGENT_SIGNING_KEY`, which stays
on Render and signs receipts and submits provider-side chain transactions.

Each execution requires the funded job identity in headers:

```bash
curl -X POST "$RECOURSE_ADAPTER_URL/agents/research-sources/execute" \
  -H 'content-type: application/json' \
  -H 'x-recourse-job-id: 1' \
  -H 'x-recourse-request-hash: sha256:...' \
  -H 'x-recourse-request-label: Research request' \
  -H 'x-recourse-capability-id: 2' \
  -H 'x-recourse-request-nonce: 4d7d1f11-8b31-4db7-9c09-7f6f2bdb7e4d' \
  --data '{"capability_id":"2","request_label":"Research request","nonce":"4d7d1f11-8b31-4db7-9c09-7f6f2bdb7e4d","request":{"query":"verifiable credentials"}}'
```

The adapter verifies that the request hash commits to the exact payload, finds
the funded job on Studio Next, executes only the selected registered
capability, and then submits the provider receipt and publishes evidence
onchain. The response includes the live output, signed receipt, evidence URL,
and transaction hashes. Results are encrypted with `RESULT_ENCRYPTION_KEY`
before being written to the service directory and, when `GITHUB_TOKEN` is
configured, to the repository's separate `evidence` branch. A server-side
agent normally uses the result returned by its execution POST; the
authenticated `GET /results/:job_id` route is the browser recovery path and
requires a Privy access token plus a wallet signature over the job-specific
access message. `/x402/request` is a legacy route name for Recourse's proprietary
native-GEN escrow-intent check. It is **not interoperable x402**, a facilitator,
or a cross-chain stablecoin bridge. All
contract and payment operations remain on Studio Next / chain `61997`.

Execution is idempotent for a committed request. If an agent loses the HTTP
response after receipt or evidence publication, it can repeat the same
capability POST with the original job ID, request, label, and nonce. The
adapter verifies the commitment and returns the encrypted stored delivery
without rerunning the provider capability.

After funding a job, the native escrow-intent route accepts a JSON or
base64-encoded JSON `x-payment` envelope:

```json
{
  "scheme": "genlayer-native",
  "network": "studio-next",
  "chain_id": 61997,
  "asset": "GEN",
  "amount": "2000000000000000000",
  "contract_address": "0x51eDCf8f3Bdbb69a6e83b1cA5076a77C2E5Cdc35",
  "action": "create_job",
  "capability_id": "2",
  "job_id": "7"
}
```

The request also carries `x-recourse-job-id` and, when selected explicitly,
`x-recourse-capability-id`. A correctly shaped header is not proof by itself:
Studio Next remains the source of truth. The adapter returns
`202 payment_intent_verified` only when every envelope field matches the
registered capability and the referenced job is currently funded with the
exact native GEN price.
