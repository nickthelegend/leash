import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';

/**
 * EIP-191 personal_sign ("\x19Ethereum Signed Message:\n" + len + message), as produced by
 * `cast wallet sign`, MetaMask personal_sign or any EVM wallet. Used to authenticate owners at the
 * gateway without the gateway ever holding a key.
 */
export function eip191Hash(message: string): Uint8Array {
  const body = Buffer.from(message, 'utf8');
  const prefix = Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`, 'utf8');
  return keccak_256(new Uint8Array(Buffer.concat([prefix, body])));
}

/** Lower-case 0x address of an uncompressed or compressed secp256k1 public key. */
export function addressOfPublicKey(pub: Uint8Array): string {
  const uncompressed = pub.length === 65 ? pub : secp256k1.ProjectivePoint.fromHex(pub).toRawBytes(false);
  return `0x${Buffer.from(keccak_256(uncompressed.slice(1))).subarray(12).toString('hex')}`;
}

/**
 * Recover the signer of an EIP-191 signature (65 bytes r || s || v, v = 27/28 or 0/1).
 * Throws on a malformed signature; a well-formed signature by another key returns another address.
 */
export function recoverEip191Signer(message: string, signature: string): string {
  const hex = signature.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{130}$/.test(hex)) throw new Error('signature must be 65 bytes (0x + 130 hex)');
  let v = parseInt(hex.slice(128, 130), 16);
  if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) throw new Error('signature v must be 27/28 (or 0/1)');
  const sig = secp256k1.Signature.fromCompact(hex.slice(0, 128)).addRecoveryBit(v);
  // Reject high-s signatures (EIP-2), as Ethereum does, so each signature has one valid encoding.
  if (sig.hasHighS()) throw new Error('signature s is not canonical (high s)');
  return addressOfPublicKey(sig.recoverPublicKey(eip191Hash(message)).toRawBytes(false));
}
