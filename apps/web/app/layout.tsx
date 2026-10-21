import type { Metadata, Viewport } from 'next';
import { Sora, Source_Code_Pro } from 'next/font/google';
import './globals.css';

const sora = Sora({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-sora',
  display: 'swap',
});

const mono = Source_Code_Pro({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'LEASH — a ZK spending leash for AI agents',
  description:
    'An AI agent can only pay inside a secret policy (a merchant allowlist and a per-transaction cap). Every payment carries a Noir UltraHonk proof, verified before any money moves.',
};

export const viewport: Viewport = {
  themeColor: '#0a1a4a',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${sora.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
