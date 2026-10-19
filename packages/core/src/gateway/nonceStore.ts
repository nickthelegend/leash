export interface AuditLogEntry {
  id: string;
  timestamp: string;
  policyCommitment: string;
  amountCents: number;
  merchantIdHash: string;
  nonce: string;
  proofVerified: boolean;
  status: 'COMPLETED' | 'REJECTED' | 'FAILED';
  rejectionReason?: string;
  paypalOrderId?: string;
  paypalStatus?: string;
  durationMs?: number;
}

export class NonceStore {
  // Map of nonce -> timestamp
  private usedNonces: Map<string, number> = new Map();
  // Public audit log showing strictly public inputs
  private auditLog: AuditLogEntry[] = [];

  isNonceUsed(nonce: string): boolean {
    return this.usedNonces.has(nonce.toString());
  }

  recordNonce(nonce: string): void {
    this.usedNonces.set(nonce.toString(), Date.now());
  }

  addAuditEntry(entry: AuditLogEntry): void {
    this.auditLog.unshift(entry);
    // Keep last 500 entries
    if (this.auditLog.length > 500) {
      this.auditLog.pop();
    }
  }

  getAuditLog(): AuditLogEntry[] {
    return [...this.auditLog];
  }

  clear(): void {
    this.usedNonces.clear();
    this.auditLog = [];
  }
}

export const nonceStore = new NonceStore();
