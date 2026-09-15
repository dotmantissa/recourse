# Audit remediation and acceptance boundary

This ledger supplements the historical findings in `AUDIT.md`; it does not
rewrite the original audit or certify a deployment. Source-level fixes and
repeatable regressions are distinct from the live release gates in `RELEASE.md`.

| Finding | Implemented remediation | Repeatable verification |
| --- | --- | --- |
| A01 | Versioned, domain-bound request/output evidence; hash and nested-schema verification; public disclosure | Contract lifecycle/schema tests; signed-delivery tests |
| A02 | Permissionless immutable evidence, delivery/evidence deadlines, deterministic recovery | Contract lifecycle and worker maintenance tests |
| A03 | All provider payouts protect the buyer challenge; evidence starts a 30-minute window | Every refund tier tested for provider/third-party callers |
| A04 | Bounded request parsing and top-level HTTP error boundary | Real malformed/oversized HTTP request regressions |
| A05 | Synthetic demo writer retired; truthful catalog; new purchase/execution release gates | Registration CLI, HTTP and browser release-gate tests; legacy listing retirement remains operational |
| A06 | Durable worker/outbox, bounded recovery and budgeted resumable autonomous buyer | Execution, maintenance and buyer tests |
| A07 | Public-address validation, redirect/DNS checks, body limits and deadlines | HTTP safety and slow-body tests |
| A08 | Client verifies provider signatures and committed delivery contents | Protocol and delivery regressions |
| A09 | Exact GenVM runner pin/checksum and executable contract toolchain | Contract lint, 64 direct cases, simulated three-validator acceptance |
| A10 | Exact large-integer chain parsing | Financial integer tests |
| A11 | Encrypted compare-and-set execution checkpoints, leases, no unknown-execution replay | Concurrent-worker, crash and publication-retry tests |
| A12 | Chain/contract/capability/job domains and expiring buyer access signatures | Cross-domain replay and malformed-signature tests |
| A13 | Grounded quotations, normalized decisions and independent validator explanation checks | Semantic rejection, agreement, disagreement and rollback tests |
| A14 | Branch-aware recipient budgets, explicit wallet cost approval, persisted uncertain transactions | Transfer-message assertions, transaction bridge and browser reload tests; live balance proofs remain open |
| A15 | Collateral described as capacity reservation, not slashed insurance | Protocol and provider-control UI |
| A16 | Native GEN payment protocol explicitly disclaims interoperable x402 | API metadata and protocol documentation |
| A17 | One manifest, truthful service limitations and nested output schemas | Every service implementation and settlement schema tested |
| A18 | Provider pause/resume/top-up/withdrawal, guarded forms and transaction recovery | Provider and desktop/mobile browser tests |
| A19 | Scoped result authorization, encrypted durable results and session-scoped browser inputs | Protocol, journal, execution and request-store tests |
| A20 | Fail-closed startup, real dependency readiness, exact deployment identity and crash-safe deployment checkpoints | Readiness, ambiguous storage-acknowledgment and deployment tests |
| A21 | Bounded per-process HTTP/RPC requests, bodies, batches and upstream concurrency | HTTP and RPC regressions; distributed edge protection is still an operator concern |
| A22 | Compatible patched UUID and URI decoder dependency graph | Clean install, CommonJS/malformed-input regressions, zero-vulnerability audit at verification time |
| A23 | Bounded registry pages; count/sample and monetary exposure history, explicit trust limitations | Pagination, reputation settlement and browser history tests |
| A24 | Native modal dialogs, scoped Tab wrapping, Escape, nested cancellation and focus restoration | Desktop/mobile Chromium against actual application components |
| A25 | Validated evidence IDs, path containment and immutable publication | Publisher traversal/overwrite regressions |

## What these tests do not establish

The browser suite substitutes only authentication/chain transports in a test-only
bundle. The independent-provider test uses real loopback HTTP and independent
signatures but a fault-injection checkpoint store. Consensus tests run actual
contract validator callbacks with controlled model responses and snapshot
rehydration; simulated internal messages are not live transfers.

Production acceptance still requires operator evidence of source/configuration
alignment, legacy escrow retirement, valid cloud credentials/storage restoration,
real Privy sign-in, live model consensus, usable post-finality challenge time and
recipient balance changes on every payout branch. Do not mark those gates passed
from a build, unit test, `/health`, or Vercel alias alone.
