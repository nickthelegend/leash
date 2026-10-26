/** VITE_HUB_API wins; otherwise production builds use the deployed hub API and dev uses localhost. */
const DEFAULT_API = import.meta.env.PROD ? "https://hub-api.201-18-198-162.sslip.io" : "http://localhost:8787";
export const API_BASE = (import.meta.env.VITE_HUB_API || DEFAULT_API).replace(/\/+$/, "");

export type Status =
  | "queued"
  | "proving"
  | "opening"
  | "thinking"
  | "delivering"
  | "delivered"
  | "accepting"
  | "paid"
  | "disputing"
  | "judging"
  | "clawed_back"
  | "undelivered"
  | "releasing"
  | "released"
  | "failed";

export const TERMINAL: ReadonlySet<Status> = new Set<Status>(["paid", "clawed_back", "released", "failed"]);

export interface HubStats {
  jobs: number;
  paid: number;
  clawedBack: number;
  musdReturnedWei: string;
  mezoSlashedWei: string;
}

export interface HubInfo {
  chainId: number;
  contract: string;
  verifier: string;
  owner: string;
  policyCommitment: string;
  escrowWei: string;
  disputeWindowSec: number;
  explorer: string;
  musd: string;
  mezo: string;
  /** Optional: per-job slash amount, if the backend exposes the contract's slashAmount. */
  slashWei?: string;
  relayer?: string;
  arbiter?: string;
  policyId?: string;
  deliveryWindowSec?: number;
  policy?: { maxPerJobCents: number; dailyCapCents: number; spentTodayCents: number };
  stats: HubStats;
}

export type AgentStyle = "accurate" | "code" | "cheap";

export interface Agent {
  id: string;
  name: string;
  tagline: string;
  description: string;
  priceCents: number;
  address: string;
  bondWei: string;
  model: string;
  style: AgentStyle;
  stats: { paid: number; clawedBack: number };
}

export interface Txs {
  open?: string;
  deliver?: string;
  accept?: string;
  dispute?: string;
  resolve?: string;
  release?: string;
  clawback?: string;
}

export interface Verdict {
  refund: boolean;
  reason: string;
  slashedWei?: string;
}

export interface HubRequest {
  id: string;
  sessionId: string;
  agentId: string;
  message: string;
  status: Status;
  jobId: number | string | null;
  priceCents: number;
  answer: string | null;
  resultHash: string | null;
  deadline: number | null;
  deliveredAt: number | null;
  disputeUntil: number | null;
  verdict: Verdict | null;
  txs: Txs;
  error: string | null;
  /** Mezo testnet block the agent read live protocol data at (Satoshi), if any */
  mezoBlock?: number;
}

export interface FeedItem {
  id: string;
  agentId: string;
  priceCents: number;
  status: Status;
  txs: Txs;
  ts: number;
}

export class ApiError extends Error {
  status: number;
  unreachable: boolean;
  constructor(message: string, status = 0, unreachable = false) {
    super(message);
    this.status = status;
    this.unreachable = unreachable;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(API_BASE + path, init);
  } catch {
    throw new ApiError(`Hub API unreachable at ${API_BASE}`, 0, true);
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new ApiError(res.ok ? `The hub returned invalid JSON for ${path}` : `HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
    }
  }
  if (!res.ok) {
    const msg = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

function post<T>(path: string, payload: unknown): Promise<T> {
  return call<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export const api = {
  hub: () => call<HubInfo>("/api/hub"),
  agents: () => call<Agent[]>("/api/agents"),
  feed: () => call<FeedItem[]>("/api/feed"),
  session: (sid: string) => call<HubRequest[]>(`/api/sessions/${encodeURIComponent(sid)}`),
  request: (id: string) => call<HubRequest>(`/api/requests/${encodeURIComponent(id)}`),
  chat: (agentId: string, message: string, sessionId: string) => post<{ requestId: string }>("/api/chat", { agentId, message, sessionId }),
  accept: (id: string, sessionId: string) => post<HubRequest>(`/api/requests/${encodeURIComponent(id)}/accept`, { sessionId }),
  dispute: (id: string, reason: string, sessionId: string) => post<HubRequest>(`/api/requests/${encodeURIComponent(id)}/dispute`, { reason, sessionId }),
};

export function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
