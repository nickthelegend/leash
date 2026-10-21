import React from 'react';

/** LEASH mark: a leash loop (ring) with a short lead. */
export function LeashMark({ className = 'w-8 h-8', tone = 'accent' }: { className?: string; tone?: 'accent' | 'deep' }) {
  const bg = tone === 'accent' ? '#ffd84d' : '#0a1a4a';
  const fg = tone === 'accent' ? '#0a1a4a' : '#ffd84d';
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" fill={bg} />
      <circle cx="13" cy="13" r="6.5" fill="none" stroke={fg} strokeWidth="3" />
      <path d="M17.8 17.8 25 25" stroke={fg} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function LeashLogo({
  className = '',
  tone = 'accent',
  href = '#top',
}: {
  className?: string;
  tone?: 'accent' | 'deep';
  href?: string;
}) {
  return (
    <a
      href={href}
      className={`inline-flex items-center gap-2.5 no-underline font-semibold text-[22px] tracking-[-0.04em] ${className}`}
      aria-label="LEASH home"
    >
      <LeashMark className="w-[30px] h-[30px]" tone={tone} />
      <span>LEASH</span>
    </a>
  );
}
