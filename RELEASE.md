# Coordinated protocol-v2 release

Local implementation tests are not evidence of production acceptance. Keep the
existing application unchanged until the gates below are met. Never publish
private keys, tokens, encrypted state keys, or private input journals. Rotate any
credential exposed in chat/logs before using it for a release.

## Offline checks

```sh
npm run verify
npm run deploy:studio-next
npm run register:agents
npm run buyer -- /path/to/reviewed-plan.json
```

The last three commands only print/validate plans. Deployment and registration
require `--run` plus explicit fee caps; the buyer additionally requires explicit
gross escrow, total fee, write-count, capability, and disclosure authorization.
Wallet/network overhead may be additional to the quoted protocol fee budgets.

`npm run preflight:release` verifies local backend/frontend environment values
against `deploy/addresses.json` and the current contract source. It fails rather
than accepting stale metadata or relying on the backend's historical fallback
address. Configure both `CONTRACT_ADDRESS` and `RECOURSE_CONTRACT_ADDRESS`, the
frontend address and chain, identical RPCs, and matching adapter/frontend origins.
It does not test credential validity or change any deployment.

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
   `npm run deploy:studio-next -- --run`. The script saves the transaction ID,
   verifies source/schema/finality, archives previous metadata locally, and
   updates both local backend address variables and the frontend address.
2. An interrupted deploy leaves a lock under `.runtime/deployments/`. Reconcile
   its saved transaction or unknown broadcast before removing the lock. The
   script never automatically resends an uncertain deployment.
3. Configure the preview backend and frontend with the same new contract, RPC,
   adapter origin, and service manifest. Set the Render contract variable
   explicitly; the blueprint no longer embeds a historical address. Do not reuse
   a service endpoint whose old funded jobs still require incompatible terms.
4. Configure provider credentials, durable storage, result encryption, and Privy
   for that environment. Register only the five implemented services using the
   reviewed registration plan and `REGISTRATION_MAX_FEE_WEI`. Registration checks
   hosted signer, deployment, schema/terms, and manifest hash before signing.
5. Run `npm run verify:studio-next` and `npm run preflight:release -- --live`.
   These remain read-only. They compare exact source/methods/finalized counts and
   public frontend/backend chain, contract, RPC, catalog, and configuration health.
   `/health` explicitly reports configuration-only readiness: passing does not
   prove storage-provider credentials, consensus liveness, or paid execution.

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
nonconsenting private data. Only after acceptance should the coordinated release
be pushed/deployed and the catalog made purchasable. A passing preflight reports
`liveAcceptanceComplete: false` deliberately; it cannot certify these gates.
