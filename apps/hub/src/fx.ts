export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/**
 * The clawback moment: coins arc from the agent (source) to the user's refund chip (target).
 * Resolves when the last coin lands. No-op (resolves at once) with reduced motion.
 */
export function flyCoins(source: Element | null, target: Element | null, count = 9): Promise<void> {
  if (!source || !target || prefersReducedMotion() || typeof document.body.animate !== "function") return Promise.resolve();
  const s = source.getBoundingClientRect();
  const t = target.getBoundingClientRect();
  const sx = s.left + Math.min(s.width, 60) / 2;
  const sy = s.top + Math.min(s.height, 60) / 2;
  const tx = t.left + 18;
  const ty = t.top + t.height / 2;
  const layer = document.createElement("div");
  layer.className = "fx-layer";
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);
  const anims: Promise<void>[] = [];
  for (let i = 0; i < count; i++) {
    const c = document.createElement("span");
    c.className = "fx-coin";
    layer.appendChild(c);
    const spread = (i - (count - 1) / 2) * 14;
    const lift = 120 + Math.random() * 90;
    const midX = (sx + tx) / 2 + spread * 2;
    const midY = Math.min(sy, ty) - lift;
    const spin = (Math.random() > 0.5 ? 1 : -1) * (540 + Math.random() * 360);
    const a = c.animate(
      [
        { transform: `translate(${sx + spread * 0.4}px, ${sy}px) scale(0.3) rotateY(0deg)`, opacity: 0 },
        { transform: `translate(${sx + spread}px, ${sy - 40}px) scale(1.15) rotateY(${spin * 0.2}deg)`, opacity: 1, offset: 0.18 },
        { transform: `translate(${midX}px, ${midY}px) scale(1) rotateY(${spin * 0.6}deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(${tx}px, ${ty}px) scale(0.55) rotateY(${spin}deg)`, opacity: 0.9 },
      ],
      { duration: 1100 + i * 40, delay: i * 75, easing: "cubic-bezier(.45,.05,.35,1)", fill: "both" },
    );
    anims.push(a.finished.then(() => undefined).catch(() => undefined));
  }
  return Promise.all(anims).then(() => {
    layer.remove();
  });
}
