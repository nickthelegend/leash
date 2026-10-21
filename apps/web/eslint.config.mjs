// Flat config for `next lint` / `eslint .`: Next's recommended rules (core-web-vitals) plus its
// TypeScript rules, loaded through FlatCompat because eslint-config-next 15 ships eslintrc presets.
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'out/**', 'next-env.d.ts'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
];

export default config;
