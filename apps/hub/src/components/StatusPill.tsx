import type { Status } from "../api";

export const STATUS_LABEL: Record<Status, string> = {
  queued: "Queued",
  proving: "Proving",
  opening: "Opening escrow",
  thinking: "Thinking",
  delivering: "Delivering",
  delivered: "Delivered",
  accepting: "Paying",
  paid: "Paid",
  disputing: "Disputing",
  judging: "Arbiter judging",
  clawed_back: "Clawed back",
  undelivered: "Undelivered",
  releasing: "Releasing",
  released: "Released",
  failed: "Failed",
};

export function statusTone(s: Status): string {
  if (s === "paid" || s === "released") return "good";
  if (s === "clawed_back") return "claw";
  if (s === "failed" || s === "undelivered") return "bad";
  if (s === "delivered") return "wait";
  return "live";
}

export function StatusPill({ status }: { status: Status }) {
  return (
    <span className={`pill pill-${statusTone(status)}`}>
      <span className="pill-dot" aria-hidden="true" />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
