// Mezo testnet access for LEASH Hub: clients, the LeashClawback ABI, and one serialized tx queue per key
// (Mezo's load-balanced RPC can lag a block behind; sends are serialized and receipts are polled until found).
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const MEZO = {
  chainId: 31611,
  rpc: process.env.MEZO_RPC_URL ?? 'https://rpc.test.mezo.org',
  explorer: 'https://explorer.test.mezo.org',
  musd: '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503',
  mezo: '0x7b7c000000000000000000000000000000000001',
  leashClawback: process.env.HUB_CONTRACT ?? '0xFc895aFe2eE6d647d7b9512d82E37a4ABE009028',
  verifier: '0xc505B0E4d6b7B6E4162f5F82D7966FD73310e336',
};

export const mezoTestnet = defineChain({
  id: MEZO.chainId,
  name: 'Mezo Testnet',
  nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
  rpcUrls: { default: { http: [MEZO.rpc] } },
  blockExplorers: { default: { name: 'Mezo Explorer', url: MEZO.explorer } },
});

export const clawbackAbi = parseAbi([
  'struct JobRequest { address owner; bytes32 policyCommitment; uint256 amountCents; bytes32 merchantIdHash; bytes32 nonce; address provider; bytes32 taskHash; uint64 deliveryWindow; }',
  'struct SpendUpdate { uint64 epoch; bytes32 prevCommit; bytes32 newCommit; }',
  'function openJob(JobRequest r, SpendUpdate spend, bytes proof) returns (uint256)',
  'function deliver(uint256 jobId, bytes32 resultHash, string uri)',
  'function accept(uint256 jobId)',
  'function release(uint256 jobId)',
  'function clawback(uint256 jobId)',
  'function dispute(uint256 jobId, bytes32 reasonHash)',
  'function resolve(uint256 jobId, bool refundOwner)',
  'function registerPolicy(bytes32 policyCommitment, address arbiter, uint256 depositWei) returns (bytes32)',
  'function deposit(bytes32 policyCommitment, uint256 amountWei)',
  'function bond(uint256 amountWei)',
  'function policyIdOf(address owner, bytes32 policyCommitment) pure returns (bytes32)',
  'function policyOwner(bytes32) view returns (address)',
  'function policyBalance(bytes32) view returns (uint256)',
  'function bondOf(address) view returns (uint256)',
  'function minBond() view returns (uint256)',
  'function disputeWindow() view returns (uint64)',
  'function jobs(uint256) view returns (bytes32 policyId, address owner, address provider, uint96 amountCents, uint64 deadline, uint64 deliveredAt, uint8 status, bytes32 taskHash, bytes32 resultHash)',
  'event JobOpened(uint256 indexed jobId, bytes32 indexed policyId, address indexed provider, uint256 amountCents, uint64 deadline, bytes32 taskHash)',
  'event JobClawedBack(uint256 indexed jobId, address indexed owner, uint256 amountWei, uint256 slashedMezo)',
]);

export const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

export const pub = createPublicClient({ chain: mezoTestnet, transport: http(MEZO.rpc, { retryCount: 4, retryDelay: 600 }) });

/** A signer whose sends run one at a time and wait for a receipt (status checked). */
export function signer(privateKey) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey ?? '')) throw new Error('signer: missing or malformed private key (Setup required)');
  const account = privateKeyToAccount(privateKey);
  const wallet = createWalletClient({ account, chain: mezoTestnet, transport: http(MEZO.rpc, { retryCount: 4, retryDelay: 600 }) });
  let tail = Promise.resolve();
  const run = (fn) => { const p = tail.then(fn, fn); tail = p.catch(() => {}); return p; };
  return {
    address: account.address,
    /** writeContract, then wait for the receipt; throws on revert. Returns { hash, receipt }. */
    write: (args) => run(async () => {
      await pub.simulateContract({ ...args, account }); // surface the revert reason before spending gas
      const hash = await wallet.writeContract({ ...args, account });
      const receipt = await waitReceipt(hash);
      if (receipt.status !== 'success') throw new Error(`tx ${hash} reverted`);
      return { hash, receipt };
    }),
    sendValue: (to, value) => run(async () => {
      const hash = await wallet.sendTransaction({ account, to, value });
      return { hash, receipt: await waitReceipt(hash) };
    }),
  };
}

export async function waitReceipt(hash, timeoutMs = 90_000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await pub.getTransactionReceipt({ hash });
      if (r) return r;
    } catch { /* not found yet, or a lagging node */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`no receipt for ${hash} after ${timeoutMs / 1000}s`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function jobIdFromReceipt(receipt) {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== MEZO.leashClawback.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: clawbackAbi, data: log.data, topics: log.topics });
      if (ev.eventName === 'JobOpened') return Number(ev.args.jobId);
    } catch { /* other event */ }
  }
  throw new Error('JobOpened not found in receipt');
}
