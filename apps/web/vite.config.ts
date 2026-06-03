import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/agent-api': {
        target: process.env.VITE_AGENT_PROXY_TARGET || 'http://localhost:3002',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/agent-api/, ''),
      },
    },
  },
})
