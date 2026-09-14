# Recourse — full-build audit and Pactline comparison

Audit date: 2026-09-14. Source baseline: `aa38c4a`.

## Executive verdict

**Recourse is a functioning Studio Next prototype, not a complete, demo-free, production-ready agent commerce system.** There is real contract code, a deployed frontend, live service implementations, funded escrow state, and a real evidence adapter. However, the central promise—independent evaluation of delivered work followed by reliable recourse—is not adequately implemented or verified.

**I cannot confirm that it is completely different from Pactline.** The unit of commerce and intended decision are materially different, but both products are provider marketplaces with terms, collateral, offchain evidence, GenLayer-backed decisions, and compensation. Recourse must make request-specific semantic adjudication and autonomous buyer recovery work convincingly to establish its distinct value.

This is an audit deliverable, not a remediation release. No application code, deployed contracts, account balances, provider registrations, or live evidence were changed. No commits, pushes, or deployments were performed. Findings below remain open.

Severity describes release and user-impact risk, not a formal CVSS score. Source-level demonstrations are explicitly distinguished from GenVM execution and live observations.

## Scope and evidence

Reviewed the tracked application source, contract, manifests, configuration, dependency audit output, tests, deployment/evidence scripts, and documentation. Compared Pactline's README, contract, and monitoring worker. Consulted installed `write-contract`, `genvm-lint`, `direct-tests`, and `integration-tests` skills and the dedicated GenLayer documentation server.

Read-only live checks targeted:

- Web: `https://recourse-gamma.vercel.app`
- Adapter: `https://recourse-evidence.onrender.com`
- Contract: `0x51eDCf8f3Bdbb69a6e83b1cA5076a77C2E5Cdc35`
- RPC: `https://studio-dev.genlayer.com/api`, chain `61997`

The deployment verifier matched local source, recorded source hash, live source, and the expected 23-method schema. Live observations are not an atomic chain snapshot; records can change between calls. Backend health reports configuration presence, not verified credential validity. HTTP availability does not establish a complete buyer lifecycle.

### Verification results

| Check | Result |
| --- | --- |
| `npm run api:check` | Passed |
| `npm run test:api` | 7/7 passed; helper-level tests, not HTTP lifecycle coverage |
| `npm --prefix web run lint` | Passed |
| `npm --prefix web run typecheck` | Passed |
| `npm --prefix web run build` | Passed using existing local environment; Next 16.3.4 |
| `npm run lint:contracts` | AST lint passed; SDK semantic validation failed to load pinned runner |
| `npm run test:contracts` | All 16 cases failed at contract loading, before business assertions |
| Integration suite | `tests/integration` is empty; package script does not supply coverage |
| `npm audit --json` | Root: zero reported vulnerable dependency entries |
| `npm --prefix web audit --json` | Web: 23 moderate affected entries; zero high/critical entries |
| `npm run verify:studio-next` | Passed deployed-source/hash/schema verification |
| Live web / adapter health | HTTP 200 / reported healthy |
| Chromium desktop/mobile smoke | Navigation and Privy login modal worked; no horizontal overflow at 1440px and 390px |
| Local HTTP adversarial checks | Reproduced unauthenticated process crash and incomplete response-body timeout |
| Extracted contract-method checks | Reproduced evidence omission, missing-evidence lockout, partial-refund challenge bypass, and lax receipt/decision validation |

Testing used Node 24.10.0 and Python 3.12.13; the documented minimum versions were not independently tested. Python source-level checks extracted actual methods, removed GenLayer decorators, and substituted in-memory storage/runtime context. **Those checks are not a replacement for GenVM, transfer execution, or multi-validator consensus tests.**

No signed-in purchase, paid transaction, adversarial production request, key rotation, deployment failover, or payout-balance verification was performed. Live provider business functions were reviewed, but a new paid execution of each capability was not performed. Browser smoke testing is not a comprehensive accessibility or device certification. Secret-pattern checks on tracked files found no matching obvious private-key/token literals; that is not a complete history or infrastructure secrets audit.

## Release-blocking findings

### A01 — Critical: adjudication cannot inspect the delivered work

Locations: `contracts/Recourse.py:158`, `contracts/Recourse.py:171`, `contracts/Recourse.py:219`, `contracts/Recourse.py:313`, `api/server.mjs:481`, `api/server.mjs:927`.

The public packet and normalized evidence contain hashes, status, latency, schema-validity, completion time, provider, and signature. They do **not** contain the committed request body, delivered output, source excerpts, or independently measured observations. `_verify_evidence` checks equality with provider-submitted metadata. `_objective_refund` trusts those metadata fields. The quality prompt receives those same fields and a buyer complaint—not the answer whose quality is disputed.

The provider's signature establishes who made an assertion, not whether the assertion is true. Multiple validators reading the same provider assertion do not independently validate fulfillment. An output hash alone cannot reveal whether sources support a claim or an answer satisfies a request. The adapter encrypts the actual result under its server key, which validators cannot use through the current contract.

Source-level reproduction: a packet containing an arbitrary `output` field was accepted when metadata matched; normalization discarded the output. There is no contract-side output hash recomputation or independent schema evaluation.

Impact: the core trust claim is unsupported, and quality decisions can be influenced by unsubstantiated complaints or provider assertions. This is not a claim that an unrelated address can directly withdraw arbitrary escrow.

Required fix: define a versioned adjudication packet with request/output commitments, bounded actual content or verifiable content-addressed references, source evidence, explicit evaluation rules, and a disclosure policy. Validators must verify hashes and evaluate the actual work. Private inputs need an explicit supported disclosure model; do not promise private adjudication while publishing plaintext secrets.

### A02 — High: receipt-without-evidence can trap buyer funds

Locations: `contracts/Recourse.py:632`, `contracts/Recourse.py:653`, `contracts/Recourse.py:676`, `contracts/Recourse.py:704`, `contracts/Recourse.py:743`.

After `submit_receipt`, `claim_timeout` stops working. Both settlement and dispute opening require evidence. Only one owner-appointed monitor can publish it. No evidence-publication deadline, buyer fallback, or independent publication path exists. Once disputed, evidence cannot be republished through `publish_evidence`, which only accepts `receipt_submitted` jobs.

Live observation: job `7` was `receipt_submitted` with an empty `evidence_id`, long after its response deadline. The source-level harness confirmed that both timeout and dispute opening reject this state. An unavailable or corrupted evidence URL can similarly prevent settlement; restoring the endpoint/monitor may recover some cases, but the buyer has no enforced fallback.

Required fix: explicit delivery/evidence deadlines, permissionless submission of validated evidence, and a deterministic refund/recovery path that does not depend on monitor availability. Begin the buyer challenge window only after verifiable delivery and evidence availability.

### A03 — High: partial refunds bypass the buyer challenge window

Location: `contracts/Recourse.py:676`.

The challenge-window restriction only applies when `refund_bps == 0`. A provider can declare a response malformed, get matching evidence published, and settle the configured partial refund immediately after the request deadline—even if the buyer should receive a larger refund for another breach. Settlement prevents a subsequent dispute.

Source-level reproduction: with a 75% malformed refund, the provider settled before `challenge_deadline_at`, retained 25%, and closed the job. This requires evidence publication; it is not an evidence-free attack.

Required fix: protect every non-buyer final settlement during the challenge window, or allow early close only with buyer consent / a full refund. Add tests for every refund percentage and caller role.

### A04 — High: one unauthenticated request crashes the adapter

Locations: `api/server.mjs:977`, `api/server.mjs:1220`.

`POST /x402/request` parses valid JSON but does not require a non-null object. JSON `null` is accepted by the parse try/catch, then `body.capability_id` throws outside a handler-level catch. Node's async HTTP request listener does not automatically turn rejected promises into responses.

Confirmed against an isolated local instance: sending `Content-Type: application/json` with body `null` caused process exit code 1. No production crash probe was sent.

Required fix: validate body shape before property access and install a complete request-handler error boundary. Add real HTTP tests for null, arrays, primitive JSON, malformed paths, oversized bodies, client disconnects, and downstream exceptions.

### A05 — High: demo artifacts are live and purchasable

Locations: `scripts/studio-dev-demo.mjs:296`, `scripts/studio-dev-demo.mjs:342`, `evidence/demo-1.json:1`, `evidence/demo-2.json:1`, `package.json:21`, `web/src/app/page.tsx:1149`.

Live capability `1` is **“Verified sources demo”**, remains **active**, and points to `https://research.example.com/v1/sources`. The deployed browser shows it in the first catalog page. It is not merely an unused fixture: buyers can attempt to fund it.

Tracked evidence files contain literal `demo_request_success`, `demo_output_success`, and malformed equivalents. The demo script fabricates measurements and receipt hashes rather than executing the advertised research endpoint. Production-facing totals/ledger also include these historical jobs.

Required fix: stop new purchases of the demo listing using its authorized provider, segregate synthetic fixtures from operational scripts, and use a clean deployment/catalog for the final build. Preserve evidence needed by existing contracts or archive the old environment; deleting historical evidence can break verification. Hiding a card or renaming a script alone is not cleanup. Test mocks should remain in tests—they are legitimate testing tools, not production claims.

### A06 — High: the lifecycle is browser-driven, not automatic recourse

Locations: `web/src/app/page.tsx:882`, `web/src/app/page.tsx:1001`, `api/server.mjs:871`, `contracts/Recourse.py:517`.

The browser waits for job finalization, locates the job, then calls the capability endpoint. The deadline starts at the funding transaction timestamp, not at acknowledged provider execution. Finality, indexing, cold starts, and network delays consume a 15–30 second service window before work begins. A buyer can also defer execution until after the deadline; the adapter does not reject expired funded work before executing it.

No persistent worker automatically discovers pending work, finishes interrupted publication, claims refunds, settles jobs, or resolves disputes. A client/script must trigger these actions. The buyer-flow smoke stops at receipt/evidence publication and does not validate settlement or recipient balances.

Live example: job `6` carried a success receipt with 1565ms service latency but settled as timeout because completion was after its absolute deadline. This proves the two timing measures differ; it does not establish which upstream delay caused that historical case.

Required fix: distinguish funding, execution acceptance, delivery, evidence publication, and adjudication timers. Bound how long the buyer may initiate work, reject expired execution, and use a durable worker/outbox for recovery and settlement. Buyer-authorized delegated actions must have explicit spend/function limits.

### A07 — High: SSRF defense and remote-work deadlines are incomplete

Locations: `api/server.mjs:286`, `api/server.mjs:310`, `api/server.mjs:323`, `api/server.mjs:337`.

Public-address filtering and redirect checks are useful, but DNS is resolved once for validation and again by `fetch`. The validated address is not pinned to the connection. DNS rebinding therefore remains a source-visible risk; no attack against an external host was performed.

The timeout is cleared when response headers arrive. Subsequent body reads have a size limit but no effective overall time limit. A peer can send headers and stall or trickle the body, leaving a job execution lock occupied. GitHub operations also lack explicit request deadlines.

Local reproduction: an actual extracted `fetchWithTimeout` set to 50ms successfully consumed a body delayed over 250ms.

Required fix: connect only to the validated public address with correct hostname/SNI, revalidate redirects, enforce egress restrictions, and keep a total deadline active through DNS, connection, redirects, and complete body consumption. Add concurrency and rate limits.

### A08 — High: third-party delivery authenticity is not checked by the browser

Locations: `web/src/lib/genlayer.ts:207`, `web/src/lib/genlayer.ts:236`, `web/src/app/page.tsx:632`, `api/server.mjs:852`.

The browser accepts arbitrary successful endpoint JSON as `JobResult`, displays it, and labels the receipt “signed receipt verified by adapter.” It does not recompute the output hash, verify the provider signature, validate the response shape, or compare returned job/capability IDs with the funded job. This is especially problematic for arbitrary third-party endpoints, which do not necessarily use the trusted hosted adapter.

The included adapter only executes capabilities owned by its single configured signing account and matches endpoint pathname, not full origin. The registration UI defaults to this adapter even when a different wallet registers a capability. That listing can accept escrow but the hosted adapter rejects the provider mismatch. Results are recovered from one global `ADAPTER_URL`, not the provider's declared storage service. Third-party evidence onboarding still depends on the privileged monitor.

Required fix: verify deliveries at the client boundary, show unverified state until checks pass, and define a complete provider protocol/SDK including execution, result recovery, evidence publication, and signer verification. Reject incompatible registrations before users pay.

### A09 — High assurance gap: the contract cannot currently be tested as configured

Locations: `contracts/Recourse.py:1`, `requirements.txt:1`, `tests/direct/test_recourse.py:1`, `package.json:13`, `package.json:17`.

Both semantic lint and the direct runner cannot find `py-genlayer:5jycge4q8k23462jtb0b9fyey1s9qz928sz2nbrd9mg4sxqg2qng` in their selected local artifacts. All 16 tests fail during loading. The integration directory is empty. The main `verify` script omits API tests. Existing direct tests do not prove child-transfer balances or validator disagreement handling; direct mode only runs the leader path.

Required fix: obtain the exact compatible runner and pin a coherent tooling set. Do not silently replace the deployed contract header with “latest” just to turn checks green. Add multi-validator tests, payout balance assertions, missing-evidence recovery, malformed/hostile output, partial-refund challenges, provider onboarding, and restart/idempotency tests to CI.

## Additional findings and completeness gaps

### A10 — Medium: financial integers are rounded in the adapter

Location: `api/server.mjs:768`; also `scripts/register-agents.mjs:37`.

Native `JSON.parse` converts onchain wei integers to JavaScript numbers. A legitimate price of `1000000000000000001` becomes `1000000000000000000`. Exact envelope comparisons and price advertisement can therefore reject correct payment or advertise the wrong amount. The frontend already uses `json-bigint`, but the adapter does not. Use decimal strings/bigints end to end and test non-round amounts above `2^53`.

### A11 — Medium: persistence/idempotency is not safe across processes or crashes

Locations: `api/server.mjs:593`, `api/server.mjs:645`, `api/server.mjs:871`, `api/server.mjs:962`.

Execution locks and the GitHub write queue are process-local. A crash after external work but before `writeResult`, or multiple replicas, can execute a request twice. GitHub recovery reads return null for failures including authorization/rate-limit/outage, conflating “not found” with “temporarily unreadable”; this can trigger re-execution. GitHub writes and two finalized chain transactions are awaited inside one HTTP request. Use durable execution leases, explicit states, an outbox, and asynchronous polling; propagate storage failures instead of treating them as absence. Do not promise exactly-once behavior for external side effects without a provider idempotency contract.

### A12 — Medium: signature and commitment domains are underspecified

Locations: `contracts/Recourse.py:574`, `api/server.mjs:132`, `api/server.mjs:250`, `web/src/app/page.tsx:95`.

The contract only checks that receipt signatures and output hashes are nonempty bounded strings; direct provider transaction authentication is present, but an independently valid receipt signature is not enforced. A source-level call accepted `not-a-signature` and `not-an-output-hash`. Receipt/result-access messages and local/durable storage IDs omit chain/contract deployment identity. A Studio reset or redeployment can reuse numeric job IDs and collide with old results/evidence/local inputs. Version and domain-separate signed material and storage by chain, contract, job, and purpose; define whether the provider transaction replaces or complements receipt-signature verification.

### A13 — Medium: semantic consensus needs stricter rules and adversarial tests

Locations: `contracts/Recourse.py:268`, `contracts/Recourse.py:286`, `contracts/Recourse.py:313`.

Independent model execution is a positive design choice. However, rule IDs are free-form and ordered, while validation requires exact equality including order and refund amount. Equivalent judgments can fail consensus. `partial_refund` accepts zero or 10000, and empty rule IDs are accepted. Complaints/terms are interpolated without an explicit untrusted-data boundary or fixed rule vocabulary. Model-format errors are classified as deterministic external errors rather than model failures that should encourage rotation. Define rule IDs and allowed refund bands, canonicalize sets, require evidence citations, constrain inconsistent decisions, and test prompt injection and model disagreement. No successful live prompt-injection exploit is claimed.

### A14 — Medium: some transfer paths are not fully budgeted or verified

Locations: `web/src/app/page.tsx:1016`, `web/src/lib/genlayer.ts:320`, `contracts/Recourse.py:370`.

The timeout UI allocates an internal transfer budget only for the buyer, but a configured timeout refund below 100% also transfers to the provider. This branch is not covered by live payout verification. Settlement updates state and emits later transfers; the UI's “settled” state does not independently confirm recipient credits. Add branch-specific fee profiles and child-transfer/balance checks, including failure recovery. This is a source-visible allocation mismatch, not a demonstrated failed live transfer. Display request price, estimated total fees, and refund separately; fixed 0.15 GEN recipient budgets can be substantial relative to a 0.01 GEN service price.

### A15 — Medium/product: collateral is a capacity reservation, not a slashed guarantee

Locations: `contracts/Recourse.py:370`, `contracts/Recourse.py:484`, `contracts/Recourse.py:517`.

Refunds come from the buyer's escrow. Settlement releases the provider's collateral reservation without reducing collateral, even for a proven breach. This is solvent request escrow, but not provider-funded compensation or economic punishment beyond foregone earnings. Explain this accurately, or implement a defined bond/slashing policy covering attributable harm. Avoid adding arbitrary penalties without a tested accounting model.

### A16 — Medium/product: the HTTP payment handshake is custom, not interoperable x402

Locations: `api/server.mjs:705`, `api/server.mjs:743`, `api/server.mjs:1220`, `web/src/app/page.tsx:421`.

The native-GEN handshake does verify existing escrow, but uses a custom `genlayer-native` scheme and response/envelope fields. Execution does not use standard x402 middleware, and `/x402/request` returns a verification status rather than executing/settling a standard paid HTTP exchange. The installed x402 package documents a versioned `x402Version` response and standard schemas that this response does not implement. A benign live unpaid handshake returned 402, but its body failed the installed `x402ResponseSchema`, including missing version/payment fields and unsupported scheme/network. Treat the current API as a documented Recourse-native protocol; claiming general x402 interoperability requires a specified supported extension/client adapter and interoperability tests, not just HTTP status 402. A stablecoin bridge is not required merely to make this claim accurate.

### A17 — Medium/product: built-in services are real but narrower than the pitch

Locations: `api/server.mjs:374`, `api/server.mjs:425`, `api/server.mjs:446`, `agents/manifest.json:5`.

Source Scout performs a Crossref search; it does not verify that every source supports the requested claim. Citation Auditor checks reachability/title, not citation entailment. Schema Mechanic validates/parses; it does not repair arbitrary malformed JSON. Code Sentinel uses bounded regex rules, not an AST/security audit. Page Brief extracts text and frequent words, not semantic synthesis. These are legitimate bounded services, not hardcoded result mocks; do not present them as autonomous reasoning agents or deeper validators.

Schemas omit required nested item fields. Confirmed: Source Scout's registered schema accepts five empty objects as sources. Strengthen nested schemas and explicit service guarantees before asserting “verified sources.”

### A18 — Medium: provider management and frontend recovery are unfinished

Locations: `contracts/Recourse.py:472`, `contracts/Recourse.py:484`, `contracts/Recourse.py:503`, `web/src/app/page.tsx:862`, `web/src/app/page.tsx:919`, `web/src/app/page.tsx:1201`.

Contract methods exist for top-up, withdrawal, and pause/resume, but corresponding provider controls are absent. A UI-only provider cannot manage capacity or recover free collateral. Registration, receipt signing, evidence submission, and dispute form handlers perform wallet/signature work outside their shared error wrapper. Signed-out registration raised an unhandled “Sign in with Privy” error in the live browser test instead of initiating login. Add management controls, role-aware onboarding, complete error handling, input bounds, fee confirmation, and persistent transaction IDs/resume state.

### A19 — Medium: result confidentiality and session cleanup are weaker than implied

Locations: `api/server.mjs:871`, `api/server.mjs:1084`, `api/server.mjs:1110`, `web/src/app/page.tsx:95`, `web/src/app/page.tsx:1206`.

The GET recovery path requires Privy plus buyer signature, but replaying the execution POST with the original request/nonce can return stored results without either. This is a bearer-commitment design, not wallet-only access; an attacker still needs the original preimage/nonce, not merely a public job hash. Browser input contexts are plaintext localStorage, result state is not cleared on logout, and access signatures have no expiry or deployment domain. Choose and document the access model; prefer wallet authorization for both paths, short-lived scoped signatures, and session-safe cleanup/recovery. Public onchain labels/complaints should carry a privacy warning.

### A20 — Medium: health/configuration and deployment recovery can mislead operators

Locations: `api/server.mjs:23`, `api/server.mjs:1016`, `deploy/deploy.mjs:88`, `render.yaml:1`, `.env.example:1`, `README.md:73`.

An isolated adapter reported `ok: true` with no signer, Privy, or encryption configuration. Health only verifies evidence-directory access. Free-tier/ephemeral local storage makes GitHub backup and key retention operationally essential, but startup does not enforce those prerequisites. Deploy updates `CONTRACT_ADDRESS` and browser config, while the adapter expects `RECOURSE_CONTRACT_ADDRESS` or a hardcoded old address; a redeploy can split the system. The adapter does not load `.env` itself, and local setup omits installing `requirements.txt` even though npm contract commands require those packages. Provide one validated deployment manifest, fail-closed startup/readiness checks, explicit environment loading, durable storage, backups/key-rotation procedures, and a reproducible clean install. `results/` should be ignored before local execution creates private delivery artifacts.

### A21 — Medium: public API/RPC abuse controls are absent

Locations: `web/src/app/api/genlayer/route.ts:3`, `api/server.mjs:977`.

The RPC proxy forwards arbitrary request text/methods without application-level size, method, batch, rate, or timeout limits. The public adapter has no per-client/concurrency rate limits; expensive repeated chain lookups and queue growth are possible. Restrict the proxy to required methods and bounded batches, enforce budgets, and add dependency timeouts. CORS controls browser response access, not authorization or protection against direct callers. The Studio faucet is appropriate for a disclosed test environment, not production economics.

### A22 — Medium: dependency advisories need targeted resolution

Locations: `web/package.json:11`, `web/package-lock.json:1`.

The web audit reported 23 moderate affected package entries, many transitively propagated through Privy/wallet tooling. They are not 23 independently demonstrated application exploits. Root advisories include `uuid` buffer bounds and `decode-uri-component` malformed-input denial of service. Review reachability and update compatible dependency paths; do not blindly use `npm audit fix --force`, whose proposed Privy change can be disruptive. Root API dependencies had no reported advisories at audit time.

### A23 — Medium/scale: unbounded registry reads and weak reputation semantics

Locations: `contracts/Recourse.py:126`, `contracts/Recourse.py:140`, `contracts/Recourse.py:798`, `contracts/Recourse.py:809`, `web/src/lib/genlayer.ts:262`.

The browser repeatedly loads complete capability/job/evidence/dispute arrays; UI pagination does not bound chain reads. Add cursor-based queries or a verifiable indexer. New providers start at 100% reliability with zero observations; scores decrease but never recover, do not weight economic exposure, and are easy to reset with a new address. The UI reads connected-wallet reputation, not a robust per-provider comparison. Show “unrated,” sample size, exposure, and a documented scoring policy; stronger identity or anti-wash-trading measures are needed before calling the score a trust signal.

### A24 — Low/medium UX: custom dialogs lack accessibility and keyboard behavior

Locations: `web/src/app/page.tsx:203`, `web/src/app/globals.css:747`.

Custom modals are divs without dialog semantics, focus trapping/return, or Escape handling. Live browser checks found zero dialog roles for the registration modal and confirmed Escape left it open. Basic responsive layout and reduced-motion styling exist, but do not establish full accessibility. Add semantic dialogs, keyboard tests, accessible error announcements, and contrast/focus audits. The missing-Privy configuration screen is implemented; it is not an unconditional hook crash.

### A25 — Medium/local utility: evidence publisher permits path traversal

Location: `scripts/publish-evidence.mjs:67`.

The CLI verifies a signature against the provider address inside the supplied packet, but builds a filename from unvalidated `job_id` plus `.json`, resolves it relative to the evidence directory, and writes it. An operator processing a malicious self-signed packet can write outside the evidence directory, subject to the operator's filesystem permissions. This requires invoking the local utility with attacker-supplied input; the HTTP API has a separate constrained ID validator. Reuse that validation, enforce resolved-path containment, and refuse unintended overwrites. A valid signature does not make a filename safe.

## Completeness assessment

| Area | Implemented | Missing or unsafe |
| --- | --- | --- |
| Contract | Exact-price escrow, caller checks, collateral reservations, receipt/evidence records, refund math, dispute entrypoints | Actual-work verification, evidence fallback, complete challenge protection, validated consensus/payout tests |
| API | Five real bounded services, signed receipts, AES-GCM result storage, chain checks, basic SSRF filtering | Crash-safe HTTP boundary, complete SSRF/time limits, durable orchestration, multiprocess idempotency, exact financial parsing |
| Frontend | Privy wallet onboarding, catalog, fund/run flow, ledger, result retrieval, dispute/settlement controls, responsive layout | Provider management, delivery verification, robust form recovery, transaction fee/outcome transparency, accessible dialogs |
| Agent interoperability | Manual committed-request POST protocol and a buyer smoke script | Complete reusable SDK/MCP/A2A integration, verified x402 client compatibility, autonomous recourse loop |
| Operations | Vercel/Render availability and verified deployed contract source | Reproducible GenVM tooling, CI/integration coverage, reliable job recovery, monitoring/alerts, clean deployment manifest |
| Demo-free requirement | Built-in service implementations use real computation/inputs | Active demo listing, tracked synthetic evidence, historical synthetic metrics, default sample form content |

Default form examples are not the same as fabricated completed work, but they remain sample content if the requirement is literally no demo/sample artifacts. Do not remove unit-test fixtures in pursuit of cosmetic “zero mock” search results.

## Is Recourse different from Pactline?

### What is genuinely different

| Dimension | Pactline | Recourse |
| --- | --- | --- |
| Primary problem | A service's reliability promise over a subscription period | Whether a particular paid agent/API request was fulfilled |
| Purchase unit | Service subscription/SLA window | Individual capability execution |
| Evidence | Repeated timestamped availability measurements from distinct monitors | Request/output commitments and a provider execution receipt |
| Intended decision | Uptime threshold breach | Timeout, malformed delivery, or semantic quality dispute |
| Compensation source | Provider collateral; refunds or credits | Buyer escrow split between refund and provider payment |
| Natural user | SaaS/API provider and subscriber | Autonomous buyer and service-providing agent |
| Distinctive potential | Multi-monitor SLA measurement and collateralized compensation | Output-aware adjudication and autonomous replacement procurement |

Code anchors: Pactline requires distinct authorized monitors and full-window observations in `../pactline/contracts/Pactline.py:719`, combines snapshots at `../pactline/contracts/Pactline.py:790`, and deducts compensation from provider collateral at `../pactline/contracts/Pactline.py:935`. Its worker publishes attestations/snapshots in `../pactline/worker/monitor.ts:247` and `../pactline/worker/monitor.ts:299`. Recourse's corresponding unit is `create_job` at `contracts/Recourse.py:517`; settlement splits buyer escrow at `contracts/Recourse.py:370`.

### What overlaps

Both are provider marketplaces using published promises, collateral, external evidence, GenLayer contracts, and compensation. Both include provider/customer interfaces and an HTTP evidence component. This is meaningful overlap in the value proposition, not merely shared React or wallet libraries.

Therefore: **different intended product, substantially overlapping trust/settlement pattern, not “completely unrelated.”** Current timing/schema-based demonstrations accentuate the overlap. The missing actual-output adjudication is precisely the feature that would make Recourse's differentiation most credible.

Recommended positioning:

> Pactline protects a subscription when a service is unavailable. Recourse protects an agent's individual purchase when the delivered work is wrong—and helps the agent get the job done elsewhere.

Use the second sentence as a roadmap, not a claim about today's completed implementation.

## Hackathon differentiation priorities

No official Agent Tank judging rubric or submission rules were present in the repository or returned by the consulted documentation search. Recommendations optimize demonstrable usefulness, GenLayer-specific judgment, agent autonomy, and reliability; they are not a prediction or guarantee of winning. Confirm network eligibility, allowed infrastructure, submission criteria, and deadlines with the official event rules.

### 1. Verifiable semantic recourse — highest priority

Implement the actual-work evidence model first. Demonstrate a real answer that is valid JSON and arrives on time but fails a specific requested claim. Validators should inspect the committed request, delivered answer, and source excerpts, then record violated rules and a justified refund. Display the exact evidence behind the decision, not invented validator thoughts or unsupported consensus percentages.

Why it stands out: uptime monitors and ordinary payment contracts cannot resolve this case. It establishes why GenLayer is essential rather than decorative.

### 2. Autonomous recovery buyer — strongest product story

Build a constrained `buyWithRecourse()` client/worker: discover providers, check price/terms, fund, retrieve and verify delivery, request recourse when warranted, then retry a different provider within the original budget/policy. Make actions resumable across restarts and approvals explicit for delegated spending.

Judge-visible result: the buyer gets useful work despite one failed provider, with a real transaction/evidence timeline. This is a clear departure from a subscription SLA dashboard.

### 3. Provider integration kit — make another team able to use it

Ship a small TypeScript/Python client or middleware, a complete API schema, signed evidence helpers, and a separate provider deployment example with its own signer. Add MCP/A2A access if useful after the protocol is sound. Prove a second independently hosted provider can participate without sharing the operator's keys or requiring an ad hoc monitor secret.

Why it stands out: an actually integrated external team is stronger evidence of utility than five in-house endpoints.

### 4. Auditable decision explorer and notifications

Show committed inputs, redacted/public evidence, rule-level outcomes, challenge deadlines, actual transfers, and recovery actions. Provide signed webhooks/polling for agents. Distinguish model agreement, transaction finality, and recipient payment rather than collapsing them into one green badge.

### 5. Outcome-backed reputation and provider economics

After reliable decisions exist, add exposure-weighted provider history, confidence/sample counts, recovery over time, and optionally ERC-8004 identity-linked validation records. Define a meaningful performance bond only if needed. Do not launch a new token or scoring system to conceal missing evidence and settlement guarantees.

Avoid broadening into bridges, multiple chains, insurance pools, or dozens of thin capabilities before the core loop works. Those increase scope without proving the distinctive value.

## Recommended execution order and acceptance gates

1. **Safety and truthfulness:** fix A01–A04; disable new demo purchases; correct unsupported verification/x402/automation claims. Preserve historical evidence safely.
2. **Lifecycle:** implement explicit delivery/evidence states, complete challenge protection, durable execution/recovery, validated provider onboarding, and branch-correct fee budgets.
3. **Reproducibility:** restore the pinned GenVM toolchain; run direct and multi-validator integration tests; add real HTTP/browser regression tests and payout-balance assertions.
4. **Clean release:** deploy a coherent demo-free environment with one manifest, verify all source/config identities, register only working capabilities, and validate startup/readiness/storage recovery.
5. **Differentiated demonstration:** run an independent provider success, a real semantic failure, and autonomous refund/replacement with public inspectable evidence. Keep intentional failure cases in an explicitly labeled test environment, not a fake production catalog.

Before saying “fully implemented,” require:

- Every listed capability executes and its nested output schema is enforced.
- A valid JSON but semantically wrong answer is adjudicated from actual committed content.
- Missing provider delivery, missing monitor evidence, unavailable storage, and validator disagreement have bounded recovery behavior.
- Buyer/provider balances prove full release, full refund, partial refund, and configured partial-timeout payouts.
- Restarted workers and multiple requests do not produce duplicate billable execution.
- An independent provider can register, execute, publish evidence, recover results, and withdraw free collateral using documented tools.
- A clean machine passes installation, contract lint/tests, API tests, frontend checks, and deployment verification.
- The final catalog and presentation contain no synthetic operational entries or fabricated success metrics.

## Documentation references

- GenLayer transaction timestamps are deterministic and pinned to transaction time: https://docs.genlayer.com/developers/intelligent-contracts/features/transaction-context
- Independent verification/equivalence requirements: https://docs.genlayer.com/developers/intelligent-contracts/equivalence-principle
- Preview-stack compatibility, profiling, fees, and successful execution checks: https://docs.genlayer.com/developers/consensus-v06-migration
- Agent commitment use cases: https://docs.genlayer.com/understand-genlayer-protocol/typical-use-cases

`datetime.now()` in this GenVM context is **not** an ordinary host-clock nondeterminism vulnerability. The timing finding concerns when the application's deadline starts relative to finalization and execution. A passing source hash or a consensus-approved receipt assertion likewise does not prove offchain fulfillment.
