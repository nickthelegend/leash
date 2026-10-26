export const DEFAULT_EXPLORER = "https://explorer.test.mezo.org";

export function centsToMusd(cents: number): string {
  const v = cents / 100;
  return v.toFixed(v < 1 && cents % 1 !== 0 ? 3 : 2);
}

/** Formats an 18-decimal wei string without floating point loss. */
export function formatWei(wei: string | null | undefined, dp = 2): string {
  if (!wei) return "0";
  let n: bigint;
  try {
    n = BigInt(wei);
  } catch {
    return "?";
  }
  const neg = n < 0n;
  if (neg) n = -n;
  const base = 10n ** 18n;
  const whole = n / base;
  const frac = n % base;
  let fracStr = frac.toString().padStart(18, "0").slice(0, dp).replace(/0+$/, "");
  if (!fracStr && frac > 0n && whole === 0n) {
    // tiny but non-zero: show more digits rather than "0"
    fracStr = frac.toString().padStart(18, "0").replace(/0+$/, "").slice(0, 6);
  }
  const wholeStr = whole.toLocaleString("en-US");
  return (neg ? "-" : "") + wholeStr + (fracStr ? "." + fracStr : "");
}

export function centsToWei(cents: number): bigint {
  return BigInt(Math.round(cents)) * 10n ** 16n;
}

export function shortHex(h: string | null | undefined, head = 6, tail = 4): string {
  if (!h) return "";
  if (h.length <= head + tail + 2) return h;
  return `${h.slice(0, head)}…${h.slice(-tail)}`;
}

export function txUrl(explorer: string | undefined, hash: string): string {
  return `${(explorer || DEFAULT_EXPLORER).replace(/\/+$/, "")}/tx/${hash}`;
}

export function addrUrl(explorer: string | undefined, addr: string): string {
  return `${(explorer || DEFAULT_EXPLORER).replace(/\/+$/, "")}/address/${addr}`;
}

export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }
  return `${m}:${String(r).padStart(2, "0")}`;
}

export function ago(ts: number, now: number): string {
  const d = Math.max(0, Math.floor(now - ts));
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export function timeOfDay(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
