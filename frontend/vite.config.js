import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const devApiProxyTarget = env.VITE_DEV_API_PROXY_TARGET || 'http://localhost:46100'

  return {
    plugins: [vue()],
    server: {
      port: 46101,
      proxy: {
        '/api': {
          target: devApiProxyTarget,
          changeOrigin: true
        }
      }
    }
  }
})
