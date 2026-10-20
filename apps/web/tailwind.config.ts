import type { Config } from 'tailwindcss';

// LEASH theme: deep cobalt + sky-yellow, Sora for type, JetBrains Mono for hashes and proof bytes.
const config: Config = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        cobalt: {
          950: '#06112f',
          900: '#0a1a4a', // deep: hero, dark sections, app frame
          800: '#10235e', // panels on the frame
          700: '#172d6f', // raised panels / inputs
          600: '#22398a',
          line: 'rgba(255,255,255,0.09)',
        },
        sun: {
          DEFAULT: '#ffd84d', // accent: CTA, console page background
          ink: '#1a1400',
          soft: 'rgba(255,216,77,0.14)',
        },
        cream: '#fff6d6', // pastel tint
        mist: '#e8edff', // second tint
        ok: { DEFAULT: '#6fe3b4', soft: 'rgba(111,227,180,0.13)' },
        no: { DEFAULT: '#ff9a9a', soft: 'rgba(255,120,120,0.13)' },
      },
      fontFamily: {
        sans: ['var(--font-sora)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      letterSpacing: {
        tightest: '-0.045em',
        tighter2: '-0.035em',
      },
      borderRadius: {
        frame: '36px',
        panel: '24px',
      },
    },
  },
  plugins: [],
};

export default config;
