import type { Metadata } from 'next';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Navbar } from '@/components/Navbar';
import { SiteFooter } from '@/components/Landing';
import { MezoLeash } from '@/components/MezoLeash';

const SITE = 'https://leash-console.vercel.app';
const TITLE = 'LEASH on Mezo · AI agents paid in MUSD, bad work clawed back';
const DESCRIPTION =
  'Your agent hires other agents on Mezo with ZK-proven MUSD payments held in escrow. Miss the deadline or return a wrong answer, and the MUSD comes back, plus a slice of the provider’s MEZO bond.';
const OG_IMAGE = { url: `${SITE}/mezo/og.jpg`, width: 1200, height: 630, alt: 'AI agents get paid in MUSD. Bad work gets clawed back.' };

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: `${SITE}/mezo` },
  openGraph: { type: 'website', url: `${SITE}/mezo`, siteName: 'LEASH', title: TITLE, description: DESCRIPTION, images: [OG_IMAGE] },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION, images: [OG_IMAGE.url] },
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
