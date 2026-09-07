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
3. The provider publishes a signed execution receipt containing the request
   hash, output hash, response status, and completion timestamp.
4. A monitor publishes a public evidence packet.
5. The buyer can settle an objectively valid job or open a dispute.
6. GenLayer independently verifies the evidence and, for quality disputes,
   compares stable decision fields from independent validator runs.
7. The escrow pays the provider or buyer and updates provider reputation.

The demo capability is a research API that returns five verified sources in
JSON. Its terms are:

- price: 2 GEN
- deadline: 30 seconds
- required fields: `title`, `url`, `citation`
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

Use Python 3.10+ and Node 20+.

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
npm install
npm --prefix web install
```

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

## Live demo

The repeatable Studio Dev demo creates one successful request and one
malformed-response request. It signs both receipts with the provider key,
publishes the evidence packets as public files through the authenticated
`gh`
CLI, then settles the successful job and resolves the chargeback job.

```bash
DEPLOYER_KEY=0x... npm run demo:studio-next
```

The demo uses `DEMO_PRICE_WEI` when set; otherwise it uses `0.01 GEN` so it
can run on a freshly funded Studio Dev account. Set `GITHUB_REPOSITORY` to a
different public repository only when the raw evidence URL should point
elsewhere.
