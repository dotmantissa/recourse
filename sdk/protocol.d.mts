export function deploymentScope(chainId: number, contractAddress: string): string;
export function canonicalJson(value: unknown): string;
export function digest(value: unknown): string;
export function requestCommitment(value: { chainId: number; contractAddress: string; capabilityId: string; requestLabel: string; request: unknown; nonce: string }): string;
export function resultAccessMessage(value: { chainId: number; contractAddress: string; jobId: string; requestHash: string; wallet: string; audience: string; expiresAt: number }): string;
export function validateAccessExpiry(expiresAt: number, now?: number): void;
export function verifyDelivery(result: unknown, job: unknown, capability: unknown): Promise<void>;
export function verifyEvidencePacket(packet: unknown, job: unknown): Promise<void>;
