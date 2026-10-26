// Mezo testnet reads for the /mezo page: plain JSON-RPC over fetch, hand-encoded eth_call data.
// Every number the page shows comes from these calls (or from public/mezo/deployment.json); nothing is invented.

export const MEZO = {
  rpc: 'https://rpc.test.mezo.org',
  chainId: 31611,
  explorer: 'https://explorer.test.mezo.org',
  // mezo-org/musd matsnet deployments
  musd: '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503',
  troveManager: '0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0',
  priceFeed: '0x86bCF0841622a5dAC14A313a15f96A95421b9366',
  borrowerOperations: '0xCdF7028ceAB81fA0C6971208e83fa7872994beE5',
} as const;

/** Mezo's minimum collateral ratio (110%), 1e18 scale. */
export const MCR = BigInt('1100000000000000000');
export const ONE = BigInt('1000000000000000000');
/** 1 cent in MUSD wei (MUSD has 18 decimals). */
export const CENT_WEI = BigInt('10000000000000000');
/** eth_getLogs on rpc.test.mezo.org refuses ranges wider than 10,000 blocks. */
export const LOG_RANGE = 9_999;

export const SEL = {
  fetchPrice: '0x0fdb11cf',
  getCurrentICR: '0xd293c710',
  getTroveStatus: '0x21e37801',
  troveHealth: '0xdb83bbff',
  policyIdOf: '0x99840b8e',
  policyBalance: '0x472d920d',
  minTroveICR: '0x6537d386',
  balanceOf: '0x70a08231',
  totalSupply: '0x18160ddd',
} as const;

export const TOPIC = {
  paymentReleased: '0x6f2be91d5b1c8ba6f0ec6d97e6404433a41cae601d77d1bb321a0b52cc042513',
  troveGuardSet: '0xd8dccf7849bf85a655b9faee4f0a42aeb0d200cad03e9c988ef89ab26a9a007b',
} as const;

export const ERR = {
  troveBelowLeash: '0x91458773',
  troveNotActive: '0xbeb97d70',
} as const;

/** MUSD TroveManager Status enum. */
export const TROVE_STATUS = ['does not exist', 'active', 'closed by owner', 'closed by liquidation', 'closed by redemption'];

export type Deployment = {
  chainId: number;
  leashMUSD: string | null;
  verifier: string | null;
  owner: string | null;
  policyCommitment: string | null;
  deployBlock: number | null;
  txs: Record<string, string | { hash: string; label?: string; note?: string }>;
};

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const B32 = /^0x[0-9a-fA-F]{64}$/;
export const isAddress = (v: unknown): v is string => typeof v === 'string' && ADDR.test(v);
export const isBytes32 = (v: unknown): v is string => typeof v === 'string' && B32.test(v);

/** Validates deployment.json: malformed values are an error to show, never silently dropped. */
export function parseDeployment(raw: unknown): Deployment {
  if (!raw || typeof raw !== 'object') throw new Error('deployment.json is not a JSON object');
  const d = raw as Record<string, unknown>;
  const addr = (k: string) => {
    const v = d[k];
    if (v === null || v === undefined) return null;
    if (!isAddress(v)) throw new Error(`deployment.json: ${k} is not an address`);
    return v;
  };
  const pc = d.policyCommitment;
  if (pc !== null && pc !== undefined && !isBytes32(pc)) throw new Error('deployment.json: policyCommitment is not a bytes32');
  const db = d.deployBlock;
  if (db !== null && db !== undefined && !(Number.isInteger(db) && (db as number) >= 0))
    throw new Error('deployment.json: deployBlock is not a block number');
  if (d.chainId !== MEZO.chainId) throw new Error(`deployment.json: chainId ${String(d.chainId)} is not Mezo testnet (${MEZO.chainId})`);
  const txs = (d.txs && typeof d.txs === 'object' ? d.txs : {}) as Deployment['txs'];
  return {
    chainId: MEZO.chainId,
    leashMUSD: addr('leashMUSD'),
    verifier: addr('verifier'),
    owner: addr('owner'),
    policyCommitment: (pc as string | null | undefined) ?? null,
    deployBlock: (db as number | null | undefined) ?? null,
    txs,
  };
}

let rpcId = 0;
export async function rpc<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(MEZO.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
      signal,
      cache: 'no-store',
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new Error(`Mezo testnet RPC unreachable (${method}): ${String((e as Error)?.message ?? e)}`);
  }
  if (!res.ok) throw new Error(`Mezo testnet RPC answered HTTP ${res.status} to ${method}`);
  const body = (await res.json().catch(() => null)) as { result?: T; error?: { message?: string } } | null;
  if (!body) throw new Error(`Mezo testnet RPC: ${method} answer was not JSON`);
  if (body.error) throw new Error(`Mezo testnet RPC ${method}: ${body.error.message ?? 'error'}`);
  return body.result as T;
}

export const encAddress = (a: string) => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
export const encBytes32 = (b: string) => b.toLowerCase().replace(/^0x/, '');
export const toHex = (n: number | bigint) => `0x${n.toString(16)}`;

export function ethCall(to: string, data: string, block: string, signal?: AbortSignal) {
  return rpc<string>('eth_call', [{ to, data }, block], signal);
}

/** The i-th 32-byte word of ABI-encoded return data, as a bigint. */
export function word(hex: string, i = 0): bigint {
  const body = hex.replace(/^0x/, '');
  const w = body.slice(i * 64, i * 64 + 64);
  if (w.length !== 64) throw new Error(`Unexpected return data (${body.length / 2} bytes)`);
  return BigInt(`0x${w}`);
}
export const wordHex = (hex: string, i = 0) => `0x${hex.replace(/^0x/, '').slice(i * 64, i * 64 + 64)}`;
export const wordAddress = (hex: string, i = 0) => `0x${hex.replace(/^0x/, '').slice(i * 64 + 24, i * 64 + 64)}`;

/** 1e18-scaled fixed point as a JS number (precision is display-only). */
export const fromE18 = (v: bigint) => Number(v / BigInt(1e12)) / 1e6;

/** getCurrentICR returns 2^256-1 for a trove with no debt. */
export const ICR_UNBOUNDED = BigInt(1e6) * ONE;

export function fmtUsd(v: number, digits = 2) {
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function fmtMusd(wei: bigint) {
  const cents = wei / CENT_WEI;
  const whole = cents / BigInt(100);
  const frac = (cents % BigInt(100)).toString().padStart(2, '0');
  return `${whole.toLocaleString('en-US')}.${frac}`;
}
export function fmtPct(v1e18: bigint, digits = 1) {
  return `${(fromE18(v1e18) * 100).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;
}
export const short = (h: string, front = 6, back = 4) => (h.length > front + back + 2 ? `${h.slice(0, front)}…${h.slice(-back)}` : h);
export const txUrl = (h: string) => `${MEZO.explorer}/tx/${h}`;
export const addressUrl = (a: string) => `${MEZO.explorer}/address/${a}`;
export const blockUrl = (n: number) => `${MEZO.explorer}/block/${n}`;
