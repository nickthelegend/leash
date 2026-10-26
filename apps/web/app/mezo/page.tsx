import type { Metadata } from 'next';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Navbar } from '@/components/Navbar';
import { SiteFooter } from '@/components/Landing';
import { MezoLeash } from '@/components/MezoLeash';

export const metadata: Metadata = {
  title: 'LEASH on Mezo · AI agents paid in MUSD, bad work clawed back',
  description:
    'Your agent hires other agents on Mezo with ZK-proven MUSD payments held in escrow. Miss the deadline or return a wrong answer, and the MUSD comes back, plus a slice of the provider’s MEZO bond.',
};

// Static: rendered at build time (and exported by scripts/build-vercel.mjs as mezo.html).
export const dynamic = 'force-static';

export default function Mezo() {
  // The hero art is optional: without public/mezo/hero.webp the hero is plain yellow and requests nothing.
  const hasHero = existsSync(join(process.cwd(), 'public/mezo/hero.webp'));
  return (
    <>
      <div className="mz-nav">
        <Navbar page="mezo" />
      </div>
      <main>
        <MezoLeash hasHero={hasHero} />
      </main>
      <SiteFooter page="mezo" />
    </>
  );
}
