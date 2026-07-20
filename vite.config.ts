import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Docker(mac)上でのファイル監視・HMRを安定させる設定。
// host: true でコンテナ外(localhost:5173)からアクセス可能にし、
// usePolling でバインドマウント越しの変更検知を確実にする。
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['apple-touch-icon.png'],
      manifest: {
        name: 'ototori',
        short_name: 'ototori',
        description: 'ジャズソロの耳コピを補助する練習アプリ。テンポを落として区間をループ再生する。',
        lang: 'ja',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        // Android等では横向きに固定される(iOSは無視するため、アプリ内で回転を促す)
        orientation: 'landscape',
        theme_color: '#0f1115',
        background_color: '#0f1115',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // wasm を含めてプリキャッシュし、オフラインでもテンポ変更が動くようにする
        globPatterns: ['**/*.{js,css,html,png,svg,wasm}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
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
