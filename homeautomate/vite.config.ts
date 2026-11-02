import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  base: '/',
  plugins: [react()],
  server: {
    port: 5177,
    proxy: {
      '/api': { target: 'http://localhost:3000', ws: true },
    },
  },
})
