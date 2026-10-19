#!/usr/bin/env node
/**
 * LEASH MCP server: lets an AI agent request a spend. Every spend goes through
 * the real Noir prover (nargo + bb) and the real Barretenberg verifier.
 * Nothing is simulated: if a tool or key is missing, the tool call errors.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  checkVerifierHealth,
  generatePaymentProof,
  getDefaultPolicy,
  verifyPaymentProof,
} from '@leash/core';

export const TOOLS = [
  {
    name: 'leash_policy',
    description:
      'Return the public commitment of the active spending policy. Rules stay private; only the commitment is revealed.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'leash_verifier_health',
    description: 'Report whether nargo, bb and the verification key are available.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  {
    name: 'leash_request_payment',
    description:
      'Prove a payment satisfies the policy (merchant allowlist + per-transaction cap) and verify the proof. Returns the proof and verification result, or the rule the request violated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        merchant: { type: 'string', description: 'Merchant name, e.g. "openai"' },
        amountCents: { type: 'integer', minimum: 1, description: 'Amount in cents' },
        nonce: { type: 'string', description: 'Unique nonce for this payment' },
        recipient: {
          type: 'string',
          description: 'Payee 0x address; defaults to LEASH_RECIPIENT_ADDRESS',
        },
      },
      required: ['merchant', 'amountCents', 'nonce'],
    },
  },
];

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const ok = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
});
const fail = (message: string): ToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

export async function callTool(
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'leash_policy': {
        const p = getDefaultPolicy();
        return ok({ name: p.name, policyCommitment: p.policyCommitment });
      }
      case 'leash_verifier_health':
        return ok(checkVerifierHealth());
      case 'leash_request_payment': {
        const merchant = args.merchant;
        const amountCents = args.amountCents;
        const nonce = args.nonce;
        if (typeof merchant !== 'string' || !merchant.trim()) {
          return fail('merchant must be a non-empty string');
        }
        if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents <= 0) {
          return fail('amountCents must be a positive integer');
        }
        if (typeof nonce !== 'string' || !nonce.trim()) {
          return fail('nonce must be a non-empty string');
        }
        const recipient = typeof args.recipient === 'string' ? args.recipient : undefined;

        const proof = generatePaymentProof({
          policy: getDefaultPolicy(),
          merchantName: merchant,
          amountCents,
          nonce,
          recipient,
        });
        const verification = verifyPaymentProof({
          proofHex: proof.proofHex,
          publicInputsHex: proof.publicInputsHex,
          expectedCommitment: proof.publicInputs.policy_commitment,
          expectedAmount: amountCents,
          expectedMerchantHash: proof.publicInputs.merchant_id_hash,
          expectedNonce: nonce,
        });
        return ok({
          approved: verification.valid,
          publicInputs: proof.publicInputs,
          proveMs: proof.durationMs,
          verification,
          proofHex: proof.proofHex,
        });
      }
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}

export function createServer(): Server {
  const server = new Server(
    { name: 'leash-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) =>
    callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>)
  );
  return server;
}

if (require.main === module) {
  createServer()
    .connect(new StdioServerTransport())
    .catch((err) => {
      console.error('[leash-mcp] failed to start:', err);
      process.exit(1);
    });
}
