# Coordinated protocol-v2 release

Local implementation tests are not evidence of production acceptance. Source
patches and a paused historical frontend may be published before migration, but
do not activate the new catalog until the gates below are met. Never publish
private keys, tokens, encrypted state keys, or private input journals. Rotate any
credential exposed in chat/logs before using it for a release.

## Offline checks

```sh
npm run verify
npm run verify:acceptance
npm run deploy:studio-next
npm run register:agents
npm run buyer -- /path/to/reviewed-plan.json
```

The last three commands only print/validate plans. Deployment and registration
require `--run` plus explicit fee caps; the buyer additionally requires explicit
gross escrow, total fee, write-count, capability, and disclosure authorization.
Wallet/network overhead may be additional to the quoted protocol fee budgets.

New browser funding/registration/resume-listing operations require matching
dependency readiness before asking for a wallet transaction. The adapter rejects
new payment intents, execution and worker writes when its source or dependencies
are stale. Existing browser settlement, dispute and recovery writes do not depend
on this availability gate. This is a fail-closed migration safeguard, not an
assertion that legacy contracts implement protocol-v2 recovery.

`deploy/release.json` is the authoritative public contract, chain, RPC, and source
identity shared by the backend and frontend. Old cloud address variables are
ignored by default. `npm run preflight:release` validates the effective targets
against `deploy/addresses.json`, the current source, and matching adapter/frontend
origins. It does not test credential validity or change any deployment.

Previews can explicitly opt into `RECOURSE_DEPLOYMENT_MODE=environment` on the
backend and `NEXT_PUBLIC_RECOURSE_DEPLOYMENT_MODE=environment` on the frontend.
Then all three corresponding address, chain, and RPC variables are required:
`RECOURSE_CONTRACT_ADDRESS`, `STUDIO_DEV_CHAIN_ID`, `STUDIO_DEV_RPC`, and
`NEXT_PUBLIC_RECOURSE_CONTRACT_ADDRESS`, `NEXT_PUBLIC_RECOURSE_CHAIN_ID`,
`NEXT_PUBLIC_RECOURSE_RPC`. Exact-source readiness is still mandatory.

## Preserve the old deployment

- Disable automatic deploys in the actual Render control plane before pushing a
  protocol migration. `render.yaml` requests manual deployment, but editing that
  file alone does not prove the existing service setting has changed.
- Inventory and explicitly pause old purchasable demo listings using their
  provider wallet. Do not delete listings, receipts, jobs, or evidence.
- Enumerate outstanding old jobs and finish delivery, settlement, or recovery
  using the old compatible service until no escrow depends on that service.
- Back up deployment metadata, scoped evidence/results, durable execution state,
  and encryption keys. Preserve old public evidence URLs. Never move old evidence
  into a new contract's scope or overwrite packets to reuse numeric job IDs.

## Stage the new environment

1. Use a separate preview environment and explicitly funded role-specific keys.
   Review the deployment plan, set `DEPLOYMENT_MAX_FEE_WEI`, then authorize
   `npm run deploy:studio-next -- --run --promote`. The script saves the transaction ID,
   verifies source/schema/finality, archives previous metadata locally, and
   updates local address variables and atomically promotes the verified public
   release manifest. Omit `--promote` for an isolated preview deployment.
2. An interrupted deploy leaves a lock under `.runtime/deployments/`. Reconcile
   its saved transaction or unknown broadcast before removing the lock. The
   script never automatically resends an uncertain deployment.
3. Configure the preview backend and frontend with the same new contract, RPC,
   adapter origin, and service manifest. Production services use the committed
   release manifest; isolated previews require the explicit override mode. Do not reuse
   a service endpoint whose old funded jobs still require incompatible terms.
4. Configure provider credentials, durable storage, result encryption, and Privy
   for that environment. Register only the five implemented services using the
   reviewed registration plan and `REGISTRATION_MAX_FEE_WEI`. Registration checks
   hosted signer, deployment, schema/terms, and manifest hash before signing.
5. Run `npm run verify:studio-next` and `npm run preflight:release -- --live`.
   These remain read-only. They compare exact source/methods/finalized counts and
   public frontend/backend chain, contract, RPC, catalog, and dependency readiness.
   `/health` remains configuration-only. `/ready` additionally checks exact
   deployed source/schema/finalized reads, authenticated Privy access, and an
   encrypted durable-storage write/read/decryption checkpoint. Results are cached
   for 60 seconds and concurrent callers share one probe, with a 20-second deadline.
   A failing probe returns HTTP 503 without exposing credentials or upstream errors.
   These checks still do not prove consensus liveness or paid execution.

## Repeatable acceptance regressions

`npm run test:integration` runs three-validator semantic agreement/disagreement
and rollback against the pinned contract with GLSim's consensus coordinator.
The fixture rehydrates storage proxies after snapshot restoration to avoid stale
SDK objects. LLM responses are controlled fixtures, not live model judgments.
The independent-provider API regression runs real loopback HTTP and independently
generated signing keys; it verifies committed delivery/evidence and retries
publication after restart without re-executing work. Its checkpoint store is a
fault-injection fixture, not evidence of cloud durability or recipient payments.

After `npm --prefix web exec -- playwright install chromium`, run
`npm --prefix web run test:browser`. Desktop/mobile Chromium tests bundle the
actual application, native dialogs and persisted transaction implementation.
Only the test bundler substitutes Privy and chain transport; no authentication
bypass or fixture route ships in production. Tests cover disclosure-required
funding, nested fee cancellation, focus restoration, provider controls/history,
announced outages and reload/finality recovery without resubmission. Real Privy
sign-in and real wallet acceptance remain separate live gates.

## Live acceptance gates still required

- Execute every listed service against real upstreams and verify signed committed
  content, nested schemas, and actual output retrieval in the browser.
- Exercise an independently hosted provider with its own signer, registration,
  evidence publication, authenticated results, and free-collateral withdrawal.
- Adjudicate valid-JSON semantic failure from committed request/output with
  multiple validators, including disagreement and unavailable-service recovery.
- Assert buyer/provider balance deltas after actual internal transfers for full
  release, full refund, partial refund, and partial timeout. Contract-emitted
  message assertions are not proof that recipients received funds.
- Observe the usable challenge window after evidence finality; timers start at
  transaction time. Confirm a buyer has time to evaluate and challenge before a
  worker can settle. Do not infer this from a local mocked clock.
- Restart workers and buyers around every write/execution checkpoint, exercise
  concurrent requests and storage outages, and prove no duplicate billable work.
- Complete signed-in browser purchase, approval rejection, reload/resume,
  disclosure, timeout, dispute, and recovery interactions.

Record transaction IDs, public evidence URLs, identities, timing, and before/after
balances in an operator-reviewed acceptance report. Do not include secrets or
nonconsenting private data. Only after acceptance should the coordinated protocol
release and its catalog be made purchasable. A passing preflight reports
`liveAcceptanceComplete: false` deliberately; it cannot certify these gates.
