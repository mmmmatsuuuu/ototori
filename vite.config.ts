import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Docker(mac)上でのファイル監視・HMRを安定させる設定。
// host: true でコンテナ外(localhost:5173)からアクセス可能にし、
// usePolling でバインドマウント越しの変更検知を確実にする。
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    watch: {
      usePolling: true,
      interval: 300,
    },
    hmr: {
      clientPort: 5173,
    },
  },
})
