# Recourse protocol v2

This protocol uses native GEN escrow and a custom HTTP request/receipt handshake,
not an interoperable x402 payment scheme. It requires a fresh contract deployment;
old deployments and their evidence must remain available for historical jobs.

## Public evidence and commitments

Inputs and outputs used for adjudication are **public**. Encrypting private
delivery checkpoints does not make published evidence confidential. Never submit
secrets, personal data, or private documents. Clients must obtain explicit buyer
consent before funding. The canonical `recourse-request-v3` document binds chain
ID, lowercase contract address, capability ID, request label, request, nonce, and
`disclosure: "public"`. Its UTF-8 SHA-256 is the job commitment.

`recourse-receipt-v2` binds the same deployment and capability, job ID, request and
output hashes, status, response code, latency, schema assertion, completion time,
and provider. Hashes use canonical sorted-key JSON; document hashes have a
`sha256:` prefix and receipt hashes do not. The provider signs the raw receipt
digest; only the onchain provider can submit it. Clients verify the signature.

Evidence includes the exact `request_json` and `output_json` strings (at most
65,536 UTF-8 bytes each), receipt fields, receipt hash, and signature. Anyone can
publish it, but the contract verifies commitments and deployment scope before
accepting it. Accepted evidence is immutable and cached onchain; settlement does
not depend on the evidence host remaining online. Paginated evidence lists omit
the packet; `get_evidence` returns the complete record.

## Lifecycle and recovery

| Phase | Deadline | Recovery |
| --- | --- | --- |
| Funded, not accepted | 30 minutes from funding | Full buyer refund |
| Accepted by provider | 5-minute start/finality allowance plus service deadline | Execution must finish within this window |
| Receipt publication | 5 minutes after execution deadline | Permissionless full refund if missing; buyer may instead claim configured timeout compensation |
| Evidence publication | 10 minutes after receipt submission | Permissionless full refund if missing, even when disputed |
| Buyer challenge | 2 minutes after evidence publication | Non-buyers cannot settle any less-than-full refund before expiry |
| Dispute resolution | 30 minutes after dispute opens | Permissionless full refund if adjudication has not resolved |

Receipt and evidence publication close at their deadlines; recovery opens at
those same timestamps. A buyer can consent to objective settlement early, but not
before the execution deadline. A full refund does not need a challenge delay.
Duplicate settlement cannot emit another transfer. Recovery releases the
provider's collateral reservation; **collateral is capacity backing, not a
slashed guarantee or additional buyer compensation**.

Timers are contract guarantees, not a guarantee of scheduler availability.
The hosted worker needs uptime, persistent storage and transaction-fee funding.
Its per-action retries are bounded; permissionless recovery remains available
when the worker cannot complete an action. Internal payouts execute on finality
and require appropriate recipient fee allocations in the submitting transaction.

## Adjudication and bounded schemas

Schema validity is independently computed from committed output, not trusted
from the provider's receipt. Supported schema types are object, array, string,
integer, boolean and null. Supported keywords are `type`, `properties`,
`required`, boolean `additionalProperties`, object `items`, `minItems`,
`maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`, and `enum`.
`number`, `$ref`, regex, combinators, and unknown keywords are rejected at
registration. Bounds are integers from 0 through 65,536; schema nesting is at
most eight, property/required lists at most 100, enums at most 20. Output arrays
are capped at 1,000 entries and output objects at 100 properties per object.

Semantic adjudication examines actual committed content. Refund levels are
0%, 25%, 50%, 75% or 100%; rule IDs are restricted. Every decision requires a
bounded rationale and one to three literal quotations from request, output or
terms. Validators independently derive the decision and check the proposed
explanation. Invalid decisions fail closed; timeout recovery remains available.
This does not eliminate LLM errors or prompt-injection risk.

Registry pages accept limits from 1 through 100 and return `items`, `next_cursor`
and `total`. Legacy list methods fail above 100 records rather than performing
unbounded reads. Reputation is the observed successful-job fraction, with zero
for providers that have no settled history; display the sample size alongside it.
