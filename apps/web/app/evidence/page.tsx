import type { Metadata } from 'next';
import { Navbar } from '@/components/Navbar';
import { EvidenceHero, EvidenceSections, SiteFooter } from '@/components/Landing';

export const metadata: Metadata = { title: 'Evidence · LEASH' };

// Everything that moved off the landing, unchanged: the tag's public inputs and private witness, the
// retractable lead of the recorded run, the four snaps and two SumcheckFailed refusals, the walk log,
// the PayPal rail (Setup required) and the fine print.
export default function Evidence() {
  return (
    <>
      <Navbar page="evidence" />
      <EvidenceHero />
      <EvidenceSections />
      <SiteFooter page="evidence" />
    </>
  );
}
