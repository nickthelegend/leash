import type { AgentStyle } from "../api";

export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="logo-mark">
      <rect width="64" height="64" rx="16" fill="var(--navy-2)" />
      <circle cx="27" cy="38" r="13" fill="none" stroke="var(--yellow)" strokeWidth="6" />
      <circle cx="27" cy="38" r="13" fill="none" stroke="var(--navy)" strokeWidth="1.2" strokeDasharray="2 5" />
      <rect x="21" y="45" width="12" height="7" rx="2" fill="var(--brass)" />
      <path d="M38 30 C46 22 48 16 50 12" fill="none" stroke="var(--cobalt-hi)" strokeWidth="5" strokeLinecap="round" />
      <circle cx="51" cy="11" r="4.5" fill="none" stroke="var(--yellow)" strokeWidth="3" />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="logo">
      <LogoMark />
      <span className="logo-word">
        LEASH<span className="logo-hub">Hub</span>
      </span>
    </span>
  );
}

const PALETTES: Record<AgentStyle, { bg: string; face: string; eye: string; accent: string }> = {
  accurate: { bg: "#1f3fd1", face: "#e8edff", eye: "#0b1530", accent: "#ffd400" },
  code: { bg: "#0b1530", face: "#ffd400", eye: "#0b1530", accent: "#3d63ff" },
  cheap: { bg: "#f7931a", face: "#fff3dc", eye: "#0b1530", accent: "#0b1530" },
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
}

/** A small robot head per agent: the style decides the face, the id nudges the details. */
/** Generated 3D portraits for the hub's agents (public/agents/<id>.webp); other ids fall back to the SVG robot. */
const PORTRAITS = new Set(["satoshi", "forge", "quickie"]);

export function AgentAvatar({ id, style, size = 44, label }: { id: string; style: AgentStyle | string; size?: number; label?: string }) {
  if (PORTRAITS.has(id)) {
    return (
      <img
        src={`/agents/${id}.webp`}
        width={size}
        height={size}
        alt={label ?? ""}
        aria-hidden={label ? undefined : true}
        className="avatar avatar-portrait"
        style={{ borderRadius: Math.round(size * 0.29) }}
        decoding="async"
      />
    );
  }
  const st = (style in PALETTES ? style : "accurate") as AgentStyle;
  const p = PALETTES[st];
  const h = hash(id);
  const tilt = (h % 7) - 3;
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} className="avatar">
      <rect width="48" height="48" rx="14" fill={p.bg} />
      <g transform={`rotate(${tilt} 24 26)`}>
        <line x1="24" y1="6" x2="24" y2="12" stroke={p.accent} strokeWidth="2" strokeLinecap="round" />
        <circle cx="24" cy="5.5" r="2.6" fill={p.accent} />
        <rect x="10" y="12" width="28" height="24" rx="8" fill={p.face} />
        <rect x="7" y="20" width="3.5" height="8" rx="1.5" fill={p.accent} />
        <rect x="37.5" y="20" width="3.5" height="8" rx="1.5" fill={p.accent} />
        {st === "accurate" && (
          <>
            <circle cx="18" cy="23" r="4.2" fill="none" stroke={p.eye} strokeWidth="2" />
            <circle cx="30" cy="23" r="4.2" fill="none" stroke={p.eye} strokeWidth="2" />
            <circle cx="18" cy="23" r="1.6" fill={p.eye} />
            <circle cx="30" cy="23" r="1.6" fill={p.eye} />
            <line x1="22.2" y1="23" x2="25.8" y2="23" stroke={p.eye} strokeWidth="1.6" />
            <path d="M19 31 Q24 33.5 29 31" fill="none" stroke={p.eye} strokeWidth="1.8" strokeLinecap="round" />
          </>
        )}
        {st === "code" && (
          <>
            <path d="M19.5 19.5 L15.5 23.5 L19.5 27.5" fill="none" stroke={p.eye} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M28.5 19.5 L32.5 23.5 L28.5 27.5" fill="none" stroke={p.eye} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            <line x1="25.4" y1="19" x2="22.6" y2="28" stroke={p.eye} strokeWidth="2" strokeLinecap="round" />
            <rect x="18" y="30.5" width="12" height="2.2" rx="1.1" fill={p.eye} />
          </>
        )}
        {st === "cheap" && (
          <>
            <rect x="14.5" y="20" width="7" height="5" rx="2.5" fill={p.eye} />
            <rect x="26.5" y="20" width="7" height="5" rx="2.5" fill={p.eye} />
            <path d="M25 26.5 L22 30.5 H25.5 L23 34" fill="none" stroke="#f7931a" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
      </g>
    </svg>
  );
}

export function CoinGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" className="coin-glyph">
      <circle cx="10" cy="10" r="9" fill="#f7931a" />
      <circle cx="10" cy="10" r="6.6" fill="none" stroke="#ffd27a" strokeWidth="1.2" />
      <text x="10" y="13.6" textAnchor="middle" fontSize="9" fontWeight="800" fill="#7a3d00" fontFamily="Sora, sans-serif">
        M
      </text>
    </svg>
  );
}
