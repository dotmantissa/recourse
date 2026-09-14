# Recourse

Recourse is a request-level escrow and automatic chargeback rail for agents
buying services from other agents or APIs.

An agent can pay for a single capability with explicit terms. The provider
returns a signed execution receipt. A public evidence packet lets GenLayer
verify the request, receipt, latency, response status, and output schema. Valid
jobs settle to the provider; breached jobs refund the buyer; semantic disputes
are adjudicated by GenLayer and settle from the same escrow.

## MVP workflow

1. A provider registers an agent or API capability with a public endpoint,
   request terms, deadline, required output schema, compensation rules, and
   collateral.
2. A buyer creates a job and funds the exact price into escrow.
3. The selected live capability executes the structured request and the
   provider publishes a signed execution receipt containing the request hash,
   output hash, response status, and completion timestamp.
4. The adapter stores the result encrypted for the buyer, then a monitor
   publishes a public evidence packet.
5. The buyer opens **My escrows** to retrieve the result, inspect evidence, and
   settle an objectively valid job or open a dispute.
6. GenLayer independently verifies the evidence and, for quality disputes,
   compares stable decision fields from independent validator runs.
7. The escrow pays the provider or buyer and updates provider reputation.

The built-in Source Scout capability is a live research API that returns five
verified sources in JSON. Its default terms are:

- price: configured onchain per capability
- deadline: 30 seconds
- required fields: `query`, `sources`
- valid response: 100% provider payment
- timeout: 100% buyer refund
- malformed response: 75% buyer refund
- disputed quality: GenLayer adjudication

## GenLayer boundary

The browser and HTTP adapter own authentication, request construction, x402
compatibility, evidence storage, and presentation. The intelligent contract
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
`run_nondet_unsafe` and compare only stable fields:

- `decision`
- `refund_bps`
- `rule_ids`

## Local setup

Use Python 3.10+ and Node 20.18.1+ (required by the HTTP transport).

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
npm install
npm --prefix web install
```

### Adapter and RPC safety checks

Run `npm run test:api` and `npm --prefix web test` for offline HTTP, egress,
storage-error, and RPC regression coverage. Both are included in `npm run verify`.
The RPC tests transpile the actual route using the installed TypeScript compiler;
they do not contact Studio or require credentials.

The adapter accepts JSON objects and canonical positive numeric ID strings (up to
20 digits). Request bodies are capped at 100 KB with a 10-second read deadline.
Public-page fetches validate every DNS answer and redirect, connect only to those
validated addresses, allow ports 80/443, and bound the decompressed body to 1 MB.
Their total timeout includes DNS, redirects, and body consumption.

Per adapter process, at most 64 HTTP handlers, 8 job executions, and 16 public-page
fetches run concurrently. Duplicate in-flight job execution returns `409`; exhausted
capacity returns `503`; the socket-IP limit is 240 requests/minute (`429`). Behind a
proxy, socket-IP limits may be shared by multiple users; forwarded client-IP headers
are not trusted. These in-memory limits and locks are not distributed leases or
restart-safe execution guarantees. Use deployment-level rate limits as well.

The browser RPC proxy allows only the listed wallet/Studio methods, batches of at
most 10, 256 KB requests, and 4 MB responses. Each instance allows 32 concurrent
requests and 120 requests/minute per Vercel-supplied client IP (a shared fallback
outside Vercel). Body reads and upstream responses have 10/25-second deadlines.

`GET /` is liveness; `GET /health` returns `503` unless local storage is readable
and writable and signing, public URL, monitor, Privy, GitHub, and result-encryption
configuration are present. This checks local readiness, not remote credential
validity or chain availability. Storage read errors fail closed instead of being
treated as absent results. Evidence CLI writes reject path-like IDs and never
overwrite an existing evidence file. Contract lifecycle, committed-output
adjudication, and durable worker recovery remain separate audit work.

### Deployment isolation and result verification

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

The deployment script uses the Studio Dev RPC and verifies chain ID `61997`,
the deployed source hash, the contract schema, and a read-only counts call.

```bash
DEPLOYER_KEY=0x... npm run deploy:studio-next
npm run verify:studio-next
```

Never place a private key in source control or in a `NEXT_PUBLIC_*` variable.

## Operational test utility

The repeatable Studio Dev test utility creates one successful request and one
malformed-response request. It signs both receipts with the provider key,
publishes the evidence packets as public files through the authenticated
`gh`
CLI, then settles the successful job and resolves the chargeback job.

```bash
DEPLOYER_KEY=0x... npm run demo:studio-next
```

The test utility uses `DEMO_PRICE_WEI` when set; otherwise it uses `0.01 GEN` so it
can run on a freshly funded Studio Dev account. Set `GITHUB_REPOSITORY` to a
different public repository only when the raw evidence URL should point
elsewhere.

## Live test agents

The adapter exposes five bounded service agents. They use real public inputs
and return real results; they are not seeded or mocked responses:

- `research-sources`: queries Crossref and returns five citable sources.
- `citation-validator`: fetches submitted URLs and reports reachability.
- `json-repair`: validates a JSON document against required keys.
- `code-policy`: runs bounded static policy checks on source code.
- `page-brief`: fetches a public page and returns a title, excerpt, and key
  phrases.

The capability definitions are recorded in `agents/manifest.json`. After the
adapter is publicly deployed, register them on Studio Next with:

```bash
RECOURSE_ADAPTER_URL=https://your-adapter.onrender.com \
DEPLOYER_KEY=0x... \
npm run register:agents
```

An autonomous buyer uses its own encrypted Studio Next signer. Privy is the
embedded-wallet and authentication layer for the browser app; it is not a
server-side agent credential. The buyer reads `get_capabilities`, creates the
exact request and a fresh nonce, computes the `recourse-request-v2` SHA-256
commitment, signs `create_job` with the capability's exact `price_wei`, and
waits for the resulting job to be readable before executing it.

The browser buyer flow is authorized by the user's Privy embedded wallet. The
`smoke:buyer-flow` utility mirrors that flow with `DEMO_BUYER_KEY` only; the
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
access message. The `/x402/request` endpoint is a native-GEN compatibility
handshake: it verifies that a matching onchain escrow exists, but it is not a
cross-chain stablecoin bridge or a fabricated payment attestation. All
contract and payment operations remain on Studio Next / chain `61997`.

Execution is idempotent for a committed request. If an agent loses the HTTP
response after receipt or evidence publication, it can repeat the same
capability POST with the original job ID, request, label, and nonce. The
adapter verifies the commitment and returns the encrypted stored delivery
without rerunning the provider capability.

After funding a job, the x402 compatibility route accepts a JSON or
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
