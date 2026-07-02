/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'sans-serif'],
        display: ['Manrope', 'Inter', 'sans-serif'],
        headline: ['Manrope', 'Inter', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      colors: {
        // Paleta dark integrada com o dcz-crm-sync (via index.css overrides).
        // Tokens próprios opcionais — todo o esquema dark real vive em index.css
        // sobrescrevendo as classes neutras do Tailwind (bg-white, text-gray-*, etc.).
        primary: '#74AEE9',
        'primary-deep': '#00346f',
        'primary-medium': '#4C709A',
        dcz: {
          bg: '#0b1623',
          card: '#122033',
          elevated: '#1a2942',
          border: 'rgba(76, 112, 154, 0.25)',
          text: '#e6edf6',
          textSecondary: '#9aabc3',
          textMuted: '#6b7d97',
        },
        whatsapp: {
          50: '#e8f5e9',
          100: '#c8e6c9',
          200: '#a5d6a7',
          300: '#81c784',
          400: '#66bb6a',
          500: '#25D366',
          600: '#128C7E',
          700: '#075E54',
          800: '#054d44',
          900: '#033d36',
        },
      },
    },
  },
  plugins: [],
};
