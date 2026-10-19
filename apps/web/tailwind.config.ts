import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        background: '#090A0F',
        card: '#0F111A',
        'card-border': '#1F2433',
        leash: {
          green: '#10B981',
          'green-glow': '#05F292',
          emerald: '#34D399',
          crimson: '#EF4444',
          cyan: '#06B6D4',
          purple: '#8B5CF6',
        },
      },
      animation: {
        'pulse-fast': 'pulse 1.2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'ping-slow': 'ping 2s cubic-bezier(0, 0, 0.2, 1) infinite',
        'spin-slow': 'spin 8s linear infinite',
        'zk-verified': 'zkGlow 1.8s ease-in-out infinite',
      },
      keyframes: {
        zkGlow: {
          '0%, 100%': {
            boxShadow: '0 0 15px rgba(16, 185, 129, 0.4), 0 0 30px rgba(5, 242, 146, 0.2)',
            borderColor: 'rgba(16, 185, 129, 0.8)',
          },
          '50%': {
            boxShadow: '0 0 35px rgba(16, 185, 129, 0.8), 0 0 70px rgba(5, 242, 146, 0.4)',
            borderColor: 'rgba(5, 242, 146, 1)',
          },
        },
      },
    },
  },
  plugins: [],
};

export default config;
