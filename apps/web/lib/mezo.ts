// Mezo testnet reads for the /mezo page: plain JSON-RPC over fetch, hand-encoded eth_call data.
// Every number the page shows comes from these calls (or from public/mezo/deployment.json); nothing is invented.

export const MEZO = {
  rpc: 'https://rpc.test.mezo.org',
  chainId: 31611,
  explorer: 'https://explorer.test.mezo.org',
  // mezo-org/musd matsnet deployments, and Mezo's MEZO token
  musd: '0x118917a40FAF1CD7a13dB0Ef56C86De7973Ac503',
  mezo: '0x7b7c000000000000000000000000000000000001',
  troveManager: '0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0',
  priceFeed: '0x86bCF0841622a5dAC14A313a15f96A95421b9366',
  borrowerOperations: '0xCdF7028ceAB81fA0C6971208e83fa7872994beE5',
} as const;

export const ONE = BigInt('1000000000000000000');
/** 1 cent in MUSD wei (MUSD has 18 decimals). */
export const CENT_WEI = BigInt('10000000000000000');
/** eth_getLogs on rpc.test.mezo.org refuses ranges wider than 10,000 blocks. */
export const LOG_RANGE = 9_999;

export const SEL = {
  fetchPrice: '0x0fdb11cf',
  totalSupply: '0x18160ddd',
  // LeashClawback
  jobs: '0x180aedf3',
  jobCount: '0x4c5d8a0f',
  bondOf: '0x72d2b6c0',
  openJobs: '0xd046a8fa',
  policyBalance: '0x472d920d',
  policyIdOf: '0x99840b8e',
  disputeWindow: '0x117f5f92',
  minBond: '0x831518b7',
  slashAmount: '0x8802834e',
} as const;

export const TOPIC = {
  jobOpened: '0x36a98d75da7a8e3ebe531e2557be53b01a53f0d49d42dac9ac42d862cd384a83',
  jobDelivered: '0xef704faeb1c0990923ca5e91e089af2aa02a4c9786c9674ee66d69f57a81d574',
  jobDisputed: '0x703048d4371fa157ebfc6261a165c1a4d1ca62f724bf5ba3d22753c460e24ba9',
  jobReleased: '0xac829ac5edc9bdd72b9facaf645f2f6a752872eefc57eb9a0404b782594ca84a',
  jobClawedBack: '0xffad8168f7772573f3840010718402d3603fc9d93684bc284400ed6ea4282ec0',
  bondChanged: '0x0cd3b4c036d7d3c2e32a738e75a571d5885202d7d6580e23dccd8ef50803f103',
} as const;

/** LeashClawback.Status */
export const JOB_STATUS = ['None', 'Pending', 'Delivered', 'Disputed', 'Released', 'ClawedBack'] as const;

/** Off-chain notes the run adds for a job (what was asked, what came back, why it was judged so). */
export type JobNote = { jobId: number; task?: string; answer?: string; correct?: string; verdict?: string };

export type Deployment = {
  chainId: number;
  leashClawback: string | null;
  verifier: string | null;
  owner: string | null;
  agent: string | null;
  provider: string | null;
  arbiter: string | null;
  policyCommitment: string | null;
  deployBlock: number | null;
  txs: Record<string, string | { hash: string; label?: string; note?: string }>;
  jobs: JobNote[];
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
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);
  const jobs: JobNote[] = Array.isArray(d.jobs)
    ? d.jobs.flatMap((j) => {
        if (!j || typeof j !== 'object') return [];
        const o = j as Record<string, unknown>;
        const id = Number(o.jobId);
        if (!Number.isInteger(id) || id <= 0) return [];
        return [{ jobId: id, task: str(o.task), answer: str(o.answer), correct: str(o.correct), verdict: str(o.verdict) }];
      })
    : [];
  return {
    chainId: MEZO.chainId,
    leashClawback: addr('leashClawback'),
    verifier: addr('verifier'),
    owner: addr('owner'),
    agent: addr('agent'),
    provider: addr('provider'),
    arbiter: addr('arbiter'),
    policyCommitment: (pc as string | null | undefined) ?? null,
    deployBlock: (db as number | null | undefined) ?? null,
    txs,
    jobs,
  };
}

let rpcId = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * One JSON-RPC call. rpc.test.mezo.org is load-balanced and a node can lag a few blocks behind: a failed call, or a
 * null result where one is required (`nullable: false`, e.g. a just-mined receipt), is retried once before it is shown.
 */
export async function rpc<T>(method: string, params: unknown[], signal?: AbortSignal, nullable = true): Promise<T> {
  try {
    const r = await rpcOnce<T>(method, params, signal);
    if (r === null && !nullable) throw new Error(`Mezo testnet RPC ${method}: no result yet`);
    return r;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    await sleep(1200);
    const r = await rpcOnce<T>(method, params, signal);
    if (r === null && !nullable) throw new Error(`Mezo testnet RPC ${method}: no result after a retry (the node may be lagging)`);
    return r;
  }
}

async function rpcOnce<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
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

export function fmtUsd(v: number, digits = 2) {
  return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function fmtMusd(wei: bigint) {
  const cents = wei / CENT_WEI;
  const whole = cents / BigInt(100);
  const frac = (cents % BigInt(100)).toString().padStart(2, '0');
  return `${whole.toLocaleString('en-US')}.${frac}`;
}
/** An 18-decimal token amount, up to `digits` decimals, trailing zeros dropped. */
export function fmtToken(wei: bigint, digits = 2) {
  const scale = BigInt(10) ** BigInt(18 - digits);
  const units = wei / scale;
  const base = BigInt(10) ** BigInt(digits);
  const whole = (units / base).toLocaleString('en-US');
  const frac = (units % base).toString().padStart(digits, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}

/** A UTF-8 `string` from ABI data, given the word index that holds its offset. */
export function abiString(hex: string, offsetWord: number): string {
  const body = hex.replace(/^0x/, '');
  const off = Number(word(hex, offsetWord)) * 2;
  const len = Number(BigInt(`0x${body.slice(off, off + 64)}`));
  const bytes = body.slice(off + 64, off + 64 + len * 2);
  const arr = new Uint8Array(bytes.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(bytes.slice(i * 2, i * 2 + 2), 16);
  return new TextDecoder().decode(arr);
}
export const short = (h: string, front = 6, back = 4) => (h.length > front + back + 2 ? `${h.slice(0, front)}…${h.slice(-back)}` : h);
export const txUrl = (h: string) => `${MEZO.explorer}/tx/${h}`;
export const addressUrl = (a: string) => `${MEZO.explorer}/address/${a}`;
export const blockUrl = (n: number) => `${MEZO.explorer}/block/${n}`;
