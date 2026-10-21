import { keccak_256 } from '@noble/hashes/sha3';

/** EVM-compatible helpers (keccak256 + abi.encode of static words) shared by the gateway, receipts and PayPal. */

const strip = (h: string) => (h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h);

export function keccak256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? Buffer.from(strip(data), 'hex') : data;
  return `0x${Buffer.from(keccak_256(bytes)).toString('hex')}`;
}

export function keccak256Utf8(text: string): string {
  return keccak256Hex(new Uint8Array(Buffer.from(text, 'utf8')));
}

/** One 32-byte ABI word for a bytes32 / uint256 / address value (hex or decimal). */
export function abiWord(value: string | number | bigint): string {
  let n: bigint;
  if (typeof value === 'bigint') n = value;
  else if (typeof value === 'number') n = BigInt(value);
  else if (/^0x[0-9a-fA-F]*$/.test(value)) n = BigInt(value);
  else if (/^[0-9]+$/.test(value)) n = BigInt(value);
  else throw new Error(`Not an ABI word: ${value}`);
  if (n < 0n || n >= 1n << 256n) throw new Error(`ABI word out of range: ${value}`);
  return n.toString(16).padStart(64, '0');
}

/** keccak256(abi.encode(w0, w1, ...)) for static 32-byte words. */
export function keccakWords(...words: (string | number | bigint)[]): string {
  return keccak256Hex(words.map(abiWord).join(''));
}

export function isAddress(a: unknown): a is string {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
}

/** Same as LeashPayment.policyIdOf(owner, commitment) = keccak256(abi.encode(owner, commitment)). */
export function policyIdOf(owner: string, policyCommitment: string): string {
  if (!isAddress(owner)) throw new Error(`owner must be a 0x-prefixed 20-byte address, got '${owner}'`);
  return keccakWords(owner, policyCommitment);
}

/**
 * PayPal merchant ids are 13 characters, pattern ^[2-9A-HJ-NP-Z]{13}$ (Orders v2 schema, account_id:
 * https://developer.paypal.com/api/orders/v2/schema.json).
 */
export const PAYPAL_MERCHANT_ID_RE = /^[2-9A-HJ-NP-Z]{13}$/;

/**
 * The payee value bound into a proof for a PayPal merchant: the low 160 bits of
 * keccak256("leash:paypal:" + merchant_id), formatted like an EVM address so it fits the circuit's
 * 160-bit recipient slot. The gateway recomputes it from the merchant id it sends to PayPal.
 */
export function paypalPayee(merchantId: string): string {
  if (!PAYPAL_MERCHANT_ID_RE.test(merchantId)) {
    throw new Error(`Invalid PayPal merchant id '${merchantId}' (expected 13 chars matching ^[2-9A-HJ-NP-Z]{13}$)`);
  }
  return `0x${keccak256Utf8(`leash:paypal:${merchantId}`).slice(-40)}`;
}
