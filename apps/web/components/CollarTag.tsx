import React from 'react';
import { RUN, short } from '@/lib/recordedRun';

/** Split a 0x hash into rows of `n` hex characters for engraving. */
function rows(hash: string, n = 16): string[] {
  const hex = hash.replace(/^0x/, '');
  const out: string[] = [];
  for (let i = 0; i < hex.length; i += n) out.push(hex.slice(i, i + n));
  return out;
}

function Engraved({ x, y, children, size = 11, spacing = 0, weight = 400 }: { x: number; y: number; children: React.ReactNode; size?: number; spacing?: number; weight?: number }) {
  // A pale copy one unit lower reads as a stamped groove on the brass.
  return (
    <>
      <text x={x} y={y + 1} textAnchor="middle" fontSize={size} letterSpacing={spacing} fontWeight={weight} fill="#ffffff" className="ct-mono">
        {children}
      </text>
      <text x={x} y={y} textAnchor="middle" fontSize={size} letterSpacing={spacing} fontWeight={weight} fill="#0a1a4a" className="ct-mono">
        {children}
      </text>
    </>
  );
}

/**
 * The policy as a collar tag: a cobalt collar with stitching, punched holes and a buckle, a D-ring,
 * and a brass tag engraved with the recorded run's real policy commitment. The rules are not on it.
 * Static by design (the page's one animation is the retractable lead).
 */
export function CollarTag({ className = '' }: { className?: string }) {
  const lines = rows(RUN.commitment);
  const holes: Array<[number, number]> = [
    [44, 188],
    [65, 208],
    [95, 226],
    [131, 241],
  ];
  return (
    <svg
      viewBox="0 0 520 670"
      className={className}
      role="img"
      aria-label={`Collar tag engraved with the policy commitment ${RUN.commitment}. The caps, allowlist and payee are not on the tag.`}
    >
      {/* collar: a closed band seen from slightly above; the back half is the lighter inside */}
      <path d="M30 150 A230 110 0 0 1 490 150" fill="none" stroke="#22398a" strokeWidth="46" />
      <path d="M30 150 A230 110 0 0 0 490 150" fill="none" stroke="#0a1a4a" strokeWidth="46" />
      <path d="M14 150 A246 126 0 0 0 506 150" fill="none" stroke="#fff6d6" strokeWidth="1.6" strokeDasharray="7 6" opacity="0.7" />
      <path d="M46 150 A214 94 0 0 0 474 150" fill="none" stroke="#fff6d6" strokeWidth="1.6" strokeDasharray="7 6" opacity="0.7" />
      {holes.map(([x, y]) => (
        <g key={`${x}-${y}`}>
          <circle cx={x} cy={y} r="6.5" fill="#ffd84d" />
          <circle cx={x} cy={y} r="6.5" fill="none" stroke="#06112f" strokeWidth="1.5" />
        </g>
      ))}
      {/* buckle */}
      <g transform="translate(441 218) rotate(-31.5)">
        <rect x="-14" y="-38" width="28" height="76" rx="7" fill="none" stroke="#06112f" strokeWidth="10" />
        <rect x="-14" y="-38" width="28" height="76" rx="7" fill="none" stroke="#fff6d6" strokeWidth="5" />
        <line x1="0" y1="-38" x2="0" y2="38" stroke="#fff6d6" strokeWidth="4" strokeLinecap="round" />
      </g>
      {/* D-ring and split ring */}
      <path d="M234 276 L286 276 Q286 326 260 326 Q234 326 234 276 Z" fill="none" stroke="#06112f" strokeWidth="11" strokeLinejoin="round" />
      <path d="M234 276 L286 276 Q286 326 260 326 Q234 326 234 276 Z" fill="none" stroke="#fff6d6" strokeWidth="6" strokeLinejoin="round" />
      <circle cx="260" cy="340" r="15" fill="none" stroke="#06112f" strokeWidth="9" />
      <circle cx="260" cy="340" r="15" fill="none" stroke="#fff6d6" strokeWidth="4.5" />

      {/* the tag */}
      <ellipse cx="260" cy="656" rx="120" ry="9" fill="#0a1a4a" opacity="0.14" />
      <circle cx="260" cy="494" r="150" fill="#f6e7a8" stroke="#0a1a4a" strokeWidth="3" />
      <circle cx="260" cy="494" r="138" fill="none" stroke="#0a1a4a" strokeWidth="1" opacity="0.35" />
      <circle cx="260" cy="364" r="10" fill="#ffd84d" stroke="#0a1a4a" strokeWidth="2.5" />

      <Engraved x={260} y={396} size={11} spacing={1.6} weight={500}>
        LEASH · POLICY COMMITMENT
      </Engraved>
      {lines.map((l, i) => (
        <Engraved key={l} x={260} y={434 + i * 26} size={18} weight={500}>
          {l}
        </Engraved>
      ))}
      <line x1="170" y1="532" x2="350" y2="532" stroke="#0a1a4a" strokeWidth="1" opacity="0.35" />
      <Engraved x={260} y={556} size={11} spacing={1.2}>
        rules: not engraved
      </Engraved>
      <Engraved x={260} y={578} size={11} spacing={1.2}>
        {`owner ${short(RUN.owner)}`}
      </Engraved>
    </svg>
  );
}
