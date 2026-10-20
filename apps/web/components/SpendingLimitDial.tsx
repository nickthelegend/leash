'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, Minus } from 'lucide-react';

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

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      onChange(Math.min(maxCents, valueCents + stepCents));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      onChange(Math.max(minCents, valueCents - stepCents));
    }
  };

  return (
    <div className="flex flex-col items-center select-none">
      {/* Dial Graphic */}
      <div className={`relative touch-none ${disabled ? 'opacity-60' : 'cursor-grab active:cursor-grabbing'}`}>
        <svg
          ref={svgRef}
          width={size}
          height={size}
          className="overflow-visible rounded-full"
          onMouseDown={onMouseDown}
          onTouchStart={onTouchStart}
          onKeyDown={onKeyDown}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label={agentName ? `Per-transaction cap for ${agentName}` : 'Per-transaction cap'}
          aria-valuemin={minCents}
          aria-valuemax={maxCents}
          aria-valuenow={valueCents}
          aria-valuetext={`${valueCents} cents ($${(valueCents / 100).toFixed(2)}) per transaction`}
          aria-disabled={disabled}
        >
          {/* Background track */}
          <path
            d={backgroundArc}
            fill="none"
            stroke="#172d6f"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />

          {/* Active track */}
          {activeArc && (
            <path
              d={activeArc}
              fill="none"
              stroke="#ffd84d"
              strokeWidth={strokeWidth}
              strokeLinecap="round"
            />
          )}

          {/* Handle knob */}
          <circle
            cx={knobPos.x}
            cy={knobPos.y}
            r={10}
            fill="#ffffff"
            stroke="#ffd84d"
            strokeWidth={4}
          />
        </svg>

        {/* Center Readout */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <span className="text-[12px] text-white/60">Rule R2 cap</span>
          <div className="flex items-baseline font-medium tracking-tightest text-white">
            <span className="text-[34px] leading-none">${Math.floor(valueCents / 100)}</span>
            <span className="text-[34px] leading-none text-white/40">
              .{String(valueCents % 100).padStart(2, '0')}
            </span>
          </div>
          <span className="mt-1 mono text-[11.5px] text-white/55">{valueCents} cents / tx</span>
        </div>
      </div>

      {/* Quick Stepper Buttons */}
      <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
        <button
          type="button"
          onClick={() => onChange(Math.max(minCents, valueCents - stepCents))}
          disabled={disabled || valueCents <= minCents}
          className="grid place-items-center w-9 h-9 rounded-full bg-cobalt-700 hover:bg-cobalt-600 text-white disabled:opacity-40 transition-colors"
          aria-label="Decrease cap by $0.50"
        >
          <Minus className="w-4 h-4" aria-hidden="true" />
        </button>

        {/* Preset chips */}
        <div className="flex items-center gap-1.5" role="group" aria-label="Cap presets">
          {presets.map((preset) => {
            const isSelected = valueCents === preset;
            return (
              <button
                key={preset}
                type="button"
                onClick={() => onChange(preset)}
                disabled={disabled}
                aria-pressed={isSelected}
                className={`h-9 px-3 rounded-full text-[13px] font-medium transition-colors disabled:opacity-50 ${
                  isSelected
                    ? 'bg-sun text-sun-ink'
                    : 'bg-cobalt-700 text-white/75 hover:text-white hover:bg-cobalt-600'
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
          className="grid place-items-center w-9 h-9 rounded-full bg-cobalt-700 hover:bg-cobalt-600 text-white disabled:opacity-40 transition-colors"
          aria-label="Increase cap by $0.50"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
