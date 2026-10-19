'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { DollarSign, Plus, Minus } from 'lucide-react';

interface SpendingLimitDialProps {
  valueCents: number; // in cents, e.g. 500 = $5.00
  onChange: (cents: number) => void;
  minCents?: number;
  maxCents?: number;
  stepCents?: number;
  disabled?: boolean;
  agentName?: string;
}

export function SpendingLimitDial({
  valueCents,
  onChange,
  minCents = 100, // $1.00
  maxCents = 2500, // $25.00
  stepCents = 50, // $0.50
  disabled = false,
  agentName,
}: SpendingLimitDialProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Dial geometry
  const size = 200;
  const strokeWidth = 14;
  const radius = (size - strokeWidth) / 2 - 10;
  const center = size / 2;

  // Arc angles (240 degree sweep: from 150 deg to 390 deg)
  const startAngle = 140;
  const endAngle = 400;
  const totalAngle = endAngle - startAngle; // 260 deg

  // Convert value to angle
  const ratio = Math.max(
    0,
    Math.min(1, (valueCents - minCents) / (maxCents - minCents))
  );
  const currentAngle = startAngle + ratio * totalAngle;

  const polarToCartesian = (
    centerX: number,
    centerY: number,
    r: number,
    angleInDegrees: number
  ) => {
    const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
    return {
      x: centerX + r * Math.cos(angleInRadians),
      y: centerY + r * Math.sin(angleInRadians),
    };
  };

  const describeArc = (
    x: number,
    y: number,
    r: number,
    start: number,
    end: number
  ) => {
    const startPoint = polarToCartesian(x, y, r, end);
    const endPoint = polarToCartesian(x, y, r, start);
    const largeArcFlag = end - start <= 180 ? '0' : '1';
    return [
      'M',
      startPoint.x,
      startPoint.y,
      'A',
      r,
      r,
      0,
      largeArcFlag,
      0,
      endPoint.x,
      endPoint.y,
    ].join(' ');
  };

  // Convert mouse/touch position to dial angle & value
  const handlePointerMove = useCallback(
    (clientX: number, clientY: number) => {
      if (!svgRef.current || disabled) return;
      const rect = svgRef.current.getBoundingClientRect();
      const x = clientX - rect.left - center;
      const y = clientY - rect.top - center;

      let deg = (Math.atan2(y, x) * 180) / Math.PI + 90;
      if (deg < 0) deg += 360;

      // Adjust relative to start angle
      let dialAngle = deg;
      if (dialAngle < startAngle - 30) {
        dialAngle += 360;
      }

      let newRatio = (dialAngle - startAngle) / totalAngle;
      newRatio = Math.max(0, Math.min(1, newRatio));

      const rawCents = minCents + newRatio * (maxCents - minCents);
      const steppedCents = Math.round(rawCents / stepCents) * stepCents;
      const clampedCents = Math.max(minCents, Math.min(maxCents, steppedCents));

      if (clampedCents !== valueCents) {
        onChange(clampedCents);
      }
    },
    [center, disabled, maxCents, minCents, onChange, startAngle, stepCents, totalAngle, valueCents]
  );

  const onMouseDown = (e: React.MouseEvent) => {
    if (disabled) return;
    setIsDragging(true);
    handlePointerMove(e.clientX, e.clientY);
  };

  const onTouchStart = (e: React.TouchEvent) => {
    if (disabled) return;
    setIsDragging(true);
    if (e.touches[0]) {
      handlePointerMove(e.touches[0].clientX, e.touches[0].clientY);
    }
  };

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        handlePointerMove(e.clientX, e.clientY);
      }
    };
    const onMouseUp = () => setIsDragging(false);

    const onTouchMove = (e: TouchEvent) => {
      if (isDragging && e.touches[0]) {
        handlePointerMove(e.touches[0].clientX, e.touches[0].clientY);
      }
    };
    const onTouchEnd = () => setIsDragging(false);

    if (isDragging) {
      window.addEventListener('mousemove', onMouseMove);
      window.addEventListener('mouseup', onMouseUp);
      window.addEventListener('touchmove', onTouchMove);
      window.addEventListener('touchend', onTouchEnd);
    }

    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [isDragging, handlePointerMove]);

  const backgroundArc = describeArc(center, center, radius, startAngle, endAngle);
  const activeArc =
    currentAngle > startAngle + 1
      ? describeArc(center, center, radius, startAngle, currentAngle)
      : '';
  const knobPos = polarToCartesian(center, center, radius, currentAngle);

  const presets = [200, 500, 1000, 2000]; // $2, $5, $10, $20

  return (
    <div className="flex flex-col items-center select-none">
      {/* Dial Graphic */}
      <div className="relative group cursor-grab active:cursor-grabbing touch-none">
        <svg
          ref={svgRef}
          width={size}
          height={size}
          className="overflow-visible"
          onMouseDown={onMouseDown}
          onTouchStart={onTouchStart}
        >
          <defs>
            <linearGradient id="dialGradient" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#05F292" />
              <stop offset="100%" stopColor="#10B981" />
            </linearGradient>
            <filter id="dialGlow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0" dy="0" stdDeviation="4" floodColor="#10B981" floodOpacity="0.6" />
            </filter>
          </defs>

          {/* Background track */}
          <path
            d={backgroundArc}
            fill="none"
            stroke="#1a2030"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />

          {/* Active green track */}
          {activeArc && (
            <path
              d={activeArc}
              fill="none"
              stroke="url(#dialGradient)"
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              filter="url(#dialGlow)"
            />
          )}

          {/* Handle knob */}
          <circle
            cx={knobPos.x}
            cy={knobPos.y}
            r={10}
            fill="#ffffff"
            stroke="#05F292"
            strokeWidth={3}
            className="transition-transform duration-75 filter drop-shadow(0 0 6px rgba(5,242,146,0.8))"
          />
        </svg>

        {/* Center Readout */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-[10px] uppercase tracking-wider font-semibold text-emerald-400/80">
            Rule R2 Cap
          </span>
          <div className="flex items-baseline font-mono font-bold text-white tracking-tight">
            <span className="text-sm text-emerald-400 mr-0.5">$</span>
            <span className="text-3xl">{(valueCents / 100).toFixed(2)}</span>
          </div>
          <span className="text-[11px] text-gray-400 font-mono">
            {valueCents} cents / tx
          </span>
        </div>
      </div>

      {/* Quick Stepper Buttons */}
      <div className="flex items-center gap-3 mt-1">
        <button
          type="button"
          onClick={() => onChange(Math.max(minCents, valueCents - stepCents))}
          disabled={disabled || valueCents <= minCents}
          className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 active:bg-white/20 border border-white/10 text-gray-300 disabled:opacity-40 transition-colors"
          title="Decrease cap by $0.50"
        >
          <Minus className="w-3.5 h-3.5" />
        </button>

        {/* Preset chips */}
        <div className="flex items-center gap-1.5">
          {presets.map((preset) => {
            const isSelected = valueCents === preset;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => onChange(preset)}
                disabled={disabled}
                className={`px-2 py-0.5 rounded text-xs font-mono font-medium transition-all ${
                  isSelected
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 shadow-[0_0_10px_rgba(16,185,129,0.3)]'
                    : 'bg-white/5 text-gray-400 hover:text-white border border-white/5'
                }`}
              >
                ${preset / 100}
              </button>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => onChange(Math.min(maxCents, valueCents + stepCents))}
          disabled={disabled || valueCents >= maxCents}
          className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 active:bg-white/20 border border-white/10 text-gray-300 disabled:opacity-40 transition-colors"
          title="Increase cap by $0.50"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
