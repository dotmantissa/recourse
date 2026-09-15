export type Capability = {
  capability_id: string;
  provider: string;
  name: string;
  endpoint: string;
  terms: string;
  deadline_seconds: number;
  output_schema: string;
  timeout_refund_bps: number;
  malformed_refund_bps: number;
  price_wei: number | string;
  collateral_wei: number | string;
  reserved_collateral_wei: number | string;
  status: "active" | "paused";
  created_at: number;
  request_count: number;
};

export type Job = {
  protocol_version?: number;
  chain_id?: number;
  contract_address?: string;
  job_id: string;
  capability_id: string;
  buyer: string;
  provider: string;
  request_hash: string;
  request_label: string;
  escrow_wei: number | string;
  funded_at: number;
  deadline_at: number;
  status: "funded" | "accepted" | "receipt_submitted" | "disputed" | "settled";
  receipt_hash: string;
  evidence_id: string;
  dispute_id: string;
  outcome: string;
  refund_bps: number;
  refund_wei: number | string;
  provider_payout_wei: number | string;
  rule_ids: string[];
  challenge_deadline_at?: number;
  acceptance_deadline_at?: number;
  accepted_at?: number;
  receipt_deadline_at?: number;
  evidence_deadline_at?: number;
  resolution_deadline_at?: number;
};

export type Receipt = {
  job_id: string;
  request_hash: string;
  output_hash: string;
  response_status: string;
  response_code: number;
  latency_ms: number;
  schema_valid: boolean;
  completed_at: string;
  receipt_signature: string;
  receipt_hash: string;
};

export type EvidenceRecord = {
  evidence_id: string;
  job_id: string;
  evidence_url: string;
  published_at: number;
  publisher: string;
};

export type Dispute = {
  dispute_id: string;
  job_id: string;
  buyer: string;
  provider: string;
  dispute_type: string;
  complaint: string;
  status: "open" | "resolved";
  decision: string;
  refund_bps: number;
  rule_ids: string[];
  opened_at: number;
  resolved_at: number;
  resolution_deadline_at?: number;
  rationale?: string;
  supporting_quotes?: { source: string; quote: string }[];
};

export type Reputation = {
  provider: string;
  jobs: number;
  successful_jobs: number;
  breached_jobs: number;
  disputed_jobs: number;
  refunded_wei: number | string;
  settled_wei?: number | string;
  provider_paid_wei?: number | string;
  reliability_bps: number;
};

export type CapabilityRequest = Record<string, unknown>;

export type JobResult = {
  request_json?: string;
  output_json?: string;
  job_id: string;
  capability_id: string;
  request_hash: string;
  request_label: string;
  request: CapabilityRequest | null;
  output: unknown;
  receipt: {
    version?: string;
    chain_id?: number;
    contract_address?: string;
    capability_id?: string;
    job_id: string;
    request_hash: string;
    output_hash: string;
    response_status: string;
    response_code: number;
    latency_ms: number;
    schema_valid: boolean;
    completed_at: string;
    provider: string;
  };
  receipt_hash: string;
  receipt_signature: string;
  evidence_url: string;
  receipt_tx_hash: string | null;
  evidence_tx_hash: string | null;
  onchain_job?: Job;
  stored_at: string;
};
