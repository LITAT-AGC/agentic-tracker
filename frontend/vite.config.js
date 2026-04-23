import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 46101,
    proxy: {
      '/api': {
        target: 'http://localhost:46100',
        changeOrigin: true
      }
    }
  }
})
