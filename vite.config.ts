import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const icecastBaseUrl = env.ICECAST_BASE_URL?.trim()

  let upstream: string | null = null
  if (icecastBaseUrl) {
    try {
      upstream = new URL(icecastBaseUrl).toString()
    } catch (error) {
      throw new Error('[vite] ICECAST_BASE_URL must be an absolute URL, e.g. https://radio.example.com')
    }
  } else if (mode === 'development') {
    throw new Error('[vite] ICECAST_BASE_URL (or VITE_ICECAST_BASE_URL) is not defined in your environment.')
  } else {
    console.warn('[vite] ICECAST_BASE_URL not supplied; build will omit stream display URL and disable dev proxy.')
  }

  const proxyConfig = upstream
    ? {
        '/api/icecast-status': {
          target: upstream,
          changeOrigin: true,
          rewrite: () => '/status-json.xsl',
          secure: false,
        },
        '/api/icecast-stream': {
          target: upstream,
          changeOrigin: true,
          rewrite: (path: string) => {
            const url = new URL(path, 'http://localhost')
            const mount = url.searchParams.get('mount') || 'stream'
            return mount.startsWith('/') ? mount : `/${mount}`
          },
          secure: false,
        },
        '/api/nowplaying': {
          target: upstream,
          changeOrigin: true,
          secure: false,
        },
      }
    : undefined

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    define: {
      'import.meta.env.ICECAST_BASE_URL': JSON.stringify(upstream ?? ''),
      'import.meta.env.ICECAST_CHANNELS': JSON.stringify(env.ICECAST_CHANNELS ?? ''),
    },
    server: proxyConfig
      ? {
          proxy: proxyConfig,
        }
      : undefined,
  }
})
