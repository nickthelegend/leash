'use client';

import React from 'react';
import { Shield, Lock, Zap, CheckCircle2, ExternalLink } from 'lucide-react';

interface NavbarProps {
  verifierOnline?: boolean;
}

export function Navbar({ verifierOnline = true }: NavbarProps) {
  return (
    <header className="sticky top-0 z-50 backdrop-blur-xl bg-[#08090d]/80 border-b border-white/10 px-4 sm:px-8 py-3.5">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        {/* Brand Lockup */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-emerald-500 to-cyan-500 p-0.5 flex items-center justify-center shadow-[0_0_15px_rgba(16,185,129,0.4)]">
            <div className="w-full h-full bg-[#090A0F] rounded-[10px] flex items-center justify-center">
              <Shield className="w-5 h-5 text-emerald-400" />
            </div>
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-base tracking-wider text-white">
                LEASH
              </span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">
                ZK-VERIFIED
              </span>
            </div>
            <p className="text-[11px] text-gray-400 font-medium">
              Zero-Knowledge Spending Policies for AI Agents
            </p>
          </div>
        </div>

        {/* Status Indicators & Meta */}
        <div className="hidden sm:flex items-center gap-3">
          {/* Noir Circuit Status */}
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-white/5 border border-white/10 text-xs font-mono text-gray-300">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Noir Circuit: R1 + R2 Active</span>
          </div>

          {/* Hackathon Target */}
          <div className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-blue-500/10 border border-blue-500/20 text-xs font-semibold text-blue-300">
            <Zap className="w-3.5 h-3.5 text-blue-400" />
            <span>PayPal AI</span>
          </div>
        </div>
      </div>
    </header>
  );
}
