import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LEASH | Zero-Knowledge Spending Policies for AI Agents',
  description:
    'Mathematically unforgeable spending limits and allowlists for autonomous AI agents via Noir UltraHonk ZK proofs & PayPal Orders API.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark">
      <body className="antialiased selection:bg-emerald-500/30 selection:text-emerald-200">
        {children}
      </body>
    </html>
  );
}
