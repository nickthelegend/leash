import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function truncateHash(hash: string, front: number = 6, back: number = 4): string {
  if (!hash) return '';
  if (hash.length <= front + back + 2) return hash;
  return `${hash.slice(0, front + 2)}...${hash.slice(-back)}`;
}
