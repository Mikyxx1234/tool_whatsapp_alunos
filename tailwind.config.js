/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
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
