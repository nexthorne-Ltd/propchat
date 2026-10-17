'use client';

import React from 'react';

interface LogoProps {
  size?: 'xs' | 'sm' | 'md' | 'lg' | number;
  showText?: boolean;
  className?: string;
  textClassName?: string;
}

const SIZES = {
  xs: 24,
  sm: 32,
  md: 40,
  lg: 48,
};

export function Logo({
  size = 'sm',
  showText = true,
  className = '',
  textClassName = '',
}: LogoProps) {
  const pixelSize = typeof size === 'number' ? size : SIZES[size] || 32;

  return (
    <div className={`flex items-center gap-2.5 select-none ${className}`}>
      <div
        className="relative shrink-0 flex items-center justify-center transition-transform duration-200 hover:scale-105"
        style={{ width: pixelSize, height: pixelSize }}
      >
        <img
          src="/logo.png"
          alt="Zen-try Logo"
          width={pixelSize}
          height={pixelSize}
          className="w-full h-full object-contain filter drop-shadow-sm"
        />
      </div>
      {showText && (
        <span
          className={`font-bold tracking-tight text-ink flex items-center ${
            pixelSize >= 40 ? 'text-[19px]' : pixelSize >= 32 ? 'text-[17px]' : 'text-[15px]'
          } ${textClassName}`}
        >
          Zen<span className="text-blue-600 dark:text-blue-500">-try</span>
        </span>
      )}
    </div>
  );
}
