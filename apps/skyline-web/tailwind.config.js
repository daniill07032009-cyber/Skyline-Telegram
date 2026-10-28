/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        skyline: {
          bg: '#090d16',
          panel: '#0f172a',
          surface: '#101725',
          border: 'rgba(255, 255, 255, 0.08)',
          borderHover: 'rgba(99, 102, 241, 0.3)',
          text: '#f8fafc',
          textSecondary: '#94a3b8',
          textMuted: '#64748b',
          accent: {
            indigo: '#6366f1',
            emerald: '#10b981',
          },
        },
      },
      fontFamily: {
        sans: ['"Inter"', 'system-ui', 'sans-serif'],
        display: ['"Manrope"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
      borderRadius: {
        xl: '12px',
        '2xl': '16px',
        '3xl': '20px',
        '4xl': '24px',
      },
      boxShadow: {
        'glow-indigo': '0 0 15px rgba(99, 102, 241, 0.3)',
        'glow-indigo-hover': '0 0 25px rgba(99, 102, 241, 0.5)',
        'glow-emerald': '0 0 15px rgba(16, 185, 129, 0.3)',
        'glass': '0 8px 32px rgba(0, 0, 0, 0.3)',
        'card': '0 4px 20px rgba(0, 0, 0, 0.25)',
      },
      backdropBlur: {
        xs: '2px',
      },
      animation: {
        'fade-in': 'fadeIn 0.4s cubic-bezier(0.16, 1, 0.3, 1) both',
        'fade-out': 'fadeOut 0.3s cubic-bezier(0.16, 1, 0.3, 1) both',
        'slide-up': 'slideUp 0.5s cubic-bezier(0.16, 1, 0.3, 1) both',
        'slide-down': 'slideDown 0.4s cubic-bezier(0.16, 1, 0.3, 1) both',
        'scale-in': 'scaleIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) both',
        'pulse-glow': 'pulseGlow 3s infinite ease-in-out',
        'float': 'float 6s infinite ease-in-out',
        'online-pulse': 'onlinePulse 2s infinite ease-in-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        fadeOut: {
          '0%': { opacity: '1' },
          '100%': { opacity: '0' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-20px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          '0%': { opacity: '0', transform: 'scale(0.95)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        pulseGlow: {
          '0%, 100%': { boxShadow: '0 0 15px rgba(99, 102, 241, 0.3)' },
          '50%': { boxShadow: '0 0 30px rgba(16, 185, 129, 0.5)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        onlinePulse: {
          '0%, 100%': { boxShadow: '0 0 0 0 rgba(16, 185, 129, 0.7)' },
          '50%': { boxShadow: '0 0 0 6px rgba(16, 185, 129, 0)' },
        },
      },
      transitionTimingFunction: {
        'skyline': 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    },
  },
  plugins: [
    function({ addUtilities }) {
      addUtilities({
        '.no-scrollbar': {
          'scrollbar-width': 'none',
        },
        '.no-scrollbar::-webkit-scrollbar': {
          display: 'none',
        },
        '.glass-border': {
          'border': '1px solid rgba(255, 255, 255, 0.08)',
        },
        '.glass-panel': {
          'background': 'rgba(15, 23, 42, 0.6)',
          'backdrop-filter': 'blur(12px)',
          '-webkit-backdrop-filter': 'blur(12px)',
        },
        '.text-gradient': {
          'background': 'linear-gradient(135deg, #6366f1 0%, #10b981 100%)',
          '-webkit-background-clip': 'text',
          '-webkit-text-fill-color': 'transparent',
          'background-clip': 'text',
        },
      });
    },
  ],
}