import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const icecastBaseUrl = env.ICECAST_BASE_URL?.trim()

  if (!icecastBaseUrl) {
    throw new Error('[vite] ICECAST_BASE_URL (or VITE_ICECAST_BASE_URL) is not defined in your environment.')
  }

  let upstream: string
  try {
    upstream = new URL(icecastBaseUrl).toString()
  } catch (error) {
    throw new Error('[vite] ICECAST_BASE_URL must be an absolute URL, e.g. https://radio.example.com')
  }

  return {
    plugins: [react()],
    define: {
      'import.meta.env.ICECAST_BASE_URL': JSON.stringify(upstream),
    },
    server: {
      proxy: {
        '/icecast-status': {
          target: upstream,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/icecast-status/, '/status-json.xsl'),
          secure: false,
        },
        '/icecast-stream': {
          target: upstream,
          changeOrigin: true,
          rewrite: () => '/stream',
          secure: false,
        },
      },
    },
  }
})
