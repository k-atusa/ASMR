import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Play, Square } from 'lucide-react'

declare global {
  interface Window {
    __ICECAST_RUNTIME_CONFIG__?: {
      ICECAST_BASE_URL?: string | null
      ICECAST_CHANNELS?: string | null
    }
  }
}

const sanitizeBaseUrl = (value?: string | null): string => (value ? value.trim().replace(/\/+$/, '') : '')

const resolveBaseUrl = (): string => {
  if (typeof window !== 'undefined') {
    const runtime = sanitizeBaseUrl(window.__ICECAST_RUNTIME_CONFIG__?.ICECAST_BASE_URL)
    if (runtime) {
      return runtime
    }
  }
  return sanitizeBaseUrl(import.meta.env.ICECAST_BASE_URL)
}

const resolveChannels = (): string => {
  if (typeof window !== 'undefined') {
    const runtime = window.__ICECAST_RUNTIME_CONFIG__?.ICECAST_CHANNELS
    if (runtime) {
      return runtime
    }
  }
  return import.meta.env.ICECAST_CHANNELS || ''
}

const STATUS_URL = '/api/icecast-status'

type MaybeSource = {
  title?: string
  listenurl?: string
  stream_start_iso8601?: string
  stream_start?: string
}

type IcecastPayload = {
  icestats?: MaybeSource & { source?: MaybeSource | MaybeSource[] }
  icecast?: MaybeSource & { source?: MaybeSource | MaybeSource[] }
}

type StationStatus = {
  title: string | null
  listenUrl: string
  streamStartIso: string | null
}

const resolveToUrl = (value: string): URL => {
  if (/^https?:\/\//i.test(value)) {
    return new URL(value)
  }

  if (typeof window !== 'undefined') {
    return new URL(value, window.location.origin)
  }

  throw new Error('Cannot resolve relative URL on the server context')
}

const normalizeStreamUrl = (candidate: string | null, mount: string): string => {
  const fallbackUrl = `/api/icecast-stream?mount=${encodeURIComponent(mount)}`
  if (!candidate) {
    return fallbackUrl
  }

  try {
    const parsed = resolveToUrl(candidate)
    const localhostHosts = ['localhost', '127.0.0.1', '::1', '0.0.0.0']
    if (localhostHosts.includes(parsed.hostname)) {
      return fallbackUrl
    }

    const configuredBase = resolveBaseUrl()
    if (configuredBase) {
      try {
        const baseParsed = new URL(configuredBase)
        if (parsed.hostname === baseParsed.hostname) {
          parsed.protocol = baseParsed.protocol
          parsed.host = baseParsed.host
          parsed.port = baseParsed.port
        }
      } catch {
        // ignore
      }
    }

    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:'
    }

    return parsed.toString()
  } catch (error) {
    console.warn('Stream URL normalization failed, falling back to proxy stream.', error)
    return fallbackUrl
  }
}

const decodeEntities = (value: string): string => {
  if (typeof window === 'undefined' || !value.includes('&')) {
    return value
  }

  const parser = new DOMParser()
  const doc = parser.parseFromString(value, 'text/html')
  return doc.documentElement.textContent ?? value
}

const cleanSongTitle = (title: string | null | undefined, mount: string): string | null => {
  if (!title) return null
  const decoded = decodeEntities(title)
  const trimmed = decoded.trim()
  const lower = trimmed.toLowerCase()

  if (lower.startsWith('mount:') || lower.startsWith('mount ')) return null

  if (
    lower.endsWith('.mp3') ||
    lower.endsWith('.ogg') ||
    lower.endsWith('.aac') ||
    lower.endsWith('.m4a') ||
    lower.endsWith('.flac') ||
    lower.includes('.mp3') ||
    lower.includes('.ogg') ||
    lower.includes('.aac')
  ) {
    return null
  }

  const cleanMount = mount.replace(/^\//, '').toLowerCase()
  const cleanMountBase = cleanMount.replace(/\.[^/.]+$/, "")

  if (lower === cleanMount || lower === `/${cleanMount}` || lower === cleanMountBase || lower === `/${cleanMountBase}`) {
    return null
  }

  const placeholders = ['live stream', 'unknown', 'various', 'various artists', 'fallback', 'default', 'stream', 'icecast', 'liquidsoap']
  if (placeholders.includes(lower)) return null

  return trimmed
}

const findStatusForMount = (payload: IcecastPayload | null, mount: string): StationStatus | null => {
  if (!payload) return null
  const base = payload.icestats ?? payload.icecast
  if (!base) return null

  const sources = Array.isArray(base.source)
    ? base.source
    : base.source
      ? [base.source]
      : [base as MaybeSource]

  const normalizedMount = mount.startsWith('/') ? mount : `/${mount}`
  const matched = sources.find(src => {
    if (!src.listenurl) return false
    try {
      const url = new URL(src.listenurl)
      return url.pathname === normalizedMount
    } catch {
      return src.listenurl.endsWith(normalizedMount)
    }
  })

  if (!matched) return null

  const rawTitle = matched.title ?? 'Live Stream'
  const listenUrl = normalizeStreamUrl(matched.listenurl ?? null, mount)
  const streamStartIso = matched.stream_start_iso8601 ?? null

  return {
    title: cleanSongTitle(rawTitle, mount),
    listenUrl,
    streamStartIso,
  }
}

const formatLiveDuration = (iso: string | null): string | null => {
  if (!iso) return null
  const start = new Date(iso).getTime()
  if (Number.isNaN(start)) return null
  const diff = Date.now() - start
  if (diff < 0) return null

  const days = Math.floor(diff / 86400000)
  const hours = Math.floor((diff % 86400000) / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }
  return `${minutes}m`
}

const formatPlaybackTime = (seconds: number): string => {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0')
  const s = Math.floor(seconds % 60).toString().padStart(2, '0')
  if (h > 0) {
    return `${h.toString().padStart(2, '0')}:${m}:${s}`
  }
  return `${m}:${s}`
}

const MarqueeText = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLSpanElement>(null)
  const [overflowAmount, setOverflowAmount] = useState(0)

  useEffect(() => {
    const checkOverflow = () => {
      const container = containerRef.current
      const text = textRef.current
      if (container && text) {
        const overflow = text.offsetWidth - container.offsetWidth
        setOverflowAmount(overflow > 0 ? overflow + 16 : 0) // Add a little extra padding so it doesn't hug the edge
      }
    }

    checkOverflow()
    // Small delay to ensure fonts have loaded and layout is ready
    const timer = setTimeout(checkOverflow, 100)
    window.addEventListener('resize', checkOverflow)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('resize', checkOverflow)
    }
  }, [children])

  const duration = Math.max(5, overflowAmount / 15)

  return (
    <div ref={containerRef} className={`overflow-hidden whitespace-nowrap ${overflowAmount > 0 ? 'mask-edges' : ''} ${className}`}>
      <span
        ref={textRef}
        className="inline-block"
        style={{
          animation: overflowAmount > 0 ? `marquee-bounce ${duration}s linear infinite alternate` : 'none',
          '--marquee-end': `-${overflowAmount}px`
        } as React.CSSProperties}
      >
        {children}
      </span>
    </div>
  )
}

const App = () => {
  const [rawPayload, setRawPayload] = useState<IcecastPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [liveClock, setLiveClock] = useState(() => Date.now())
  const audioRef = useRef<HTMLAudioElement>(null)
  const hasLoadedOnce = useRef(false)

  const [theme, setTheme] = useState<'dark' | 'light' | 'system'>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('theme') as 'dark' | 'light' | 'system') || 'system'
    }
    return 'system'
  })

  const channels = useMemo(() => {
    const rawChannels = resolveChannels() || 'club.mp3:Club,china.mp3:China,edm.mp3:EDM,jpop.mp3:J-Pop,kpop.mp3:K-Pop,pop.mp3:Pop'
    return rawChannels.split(',').map(item => {
      const parts = item.trim().split(':')
      const mount = parts[0].trim()
      let name = parts[1]?.trim()
      if (!name) {
        const basename = mount.replace(/\.[^/.]+$/, "")
        name = basename.charAt(0).toUpperCase() + basename.slice(1)
      }
      return { mount, name }
    }).filter(c => c.mount)
  }, [])

  const [selectedChannel, setSelectedChannel] = useState<{ mount: string; name: string } | null>(null)
  const [isClosing, setIsClosing] = useState(false)
  const [nowPlayingTitle, setNowPlayingTitle] = useState<string | null>(null)
  const [playbackTime, setPlaybackTime] = useState(0)

  useEffect(() => {
    setPlaybackTime(0)
  }, [selectedChannel?.mount])

  useEffect(() => {
    if (!selectedChannel) {
      setNowPlayingTitle(null)
      return
    }

    const channelName = selectedChannel.mount.replace(/\.[^/.]+$/, "")
    const controller = new AbortController()

    const fetchNowPlaying = async () => {
      try {
        const res = await fetch(`/api/nowplaying/${channelName}`, { signal: controller.signal })
        if (res.ok) {
          const data = await res.json()
          setNowPlayingTitle(data.title || null)
        } else {
          setNowPlayingTitle(null)
        }
      } catch (err) {
        // ignore
      }
    }

    fetchNowPlaying()
    const intervalId = window.setInterval(fetchNowPlaying, 10000)

    return () => {
      controller.abort()
      window.clearInterval(intervalId)
    }
  }, [selectedChannel])

  useEffect(() => {
    const root = window.document.documentElement

    const applyTheme = () => {
      if (theme === 'system') {
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches
        if (isDark) {
          root.classList.add('dark')
        } else {
          root.classList.remove('dark')
        }
      } else if (theme === 'dark') {
        root.classList.add('dark')
      } else {
        root.classList.remove('dark')
      }
    }

    applyTheme()
    localStorage.setItem('theme', theme)

    if (theme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
      const listener = () => applyTheme()
      mediaQuery.addEventListener('change', listener)
      return () => mediaQuery.removeEventListener('change', listener)
    }
  }, [theme])

  const cycleTheme = () => {
    setTheme(prev => {
      if (prev === 'dark') return 'light'
      if (prev === 'light') return 'system'
      return 'dark'
    })
  }

  const status = useMemo(() => {
    if (!selectedChannel) return null
    return findStatusForMount(rawPayload, selectedChannel.mount)
  }, [rawPayload, selectedChannel])

  const refreshStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(STATUS_URL, {
        method: 'GET',
        cache: 'no-store',
        signal,
        headers: {
          Accept: 'application/json',
        },
      })

      if (!response.ok) {
        throw new Error(`Icecast status failed (${response.status})`)
      }

      const payload = (await response.json()) as IcecastPayload
      setRawPayload(payload)
      setError(null)
      hasLoadedOnce.current = true
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
      const message = err instanceof Error ? err.message : 'Something unexpected happened.'
      setError(message)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    refreshStatus(controller.signal)

    const intervalId = window.setInterval(() => {
      refreshStatus()
    }, 10000)

    return () => {
      controller.abort()
      window.clearInterval(intervalId)
    }
  }, [refreshStatus])

  useEffect(() => {
    const tickId = window.setInterval(() => {
      setLiveClock(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(tickId)
    }
  }, [])

  useEffect(() => {
    const player = audioRef.current
    if (!player || !selectedChannel) return

    player.pause()
    player.load()
    setIsPlaying(false)

    // Auto-play when selecting a new channel
    player.play().then(() => {
      setIsPlaying(true)
      setError(null)
    }).catch(err => {
      console.warn("Auto-play prevented", err)
      // We don't block the UI, just require manual play click.
    })
  }, [selectedChannel?.mount])

  const globalUptime = useMemo(() => {
    if (!rawPayload) return null
    for (const chan of channels) {
      const chanStatus = findStatusForMount(rawPayload, chan.mount)
      if (chanStatus?.streamStartIso) {
        return formatLiveDuration(chanStatus.streamStartIso)
      }
    }
    return null
  }, [rawPayload, channels, liveClock])

  const streamPlayUrl = useMemo(() => {
    if (!selectedChannel) return ''
    return status?.listenUrl || `/api/icecast-stream?mount=${encodeURIComponent(selectedChannel.mount)}`
  }, [status?.listenUrl, selectedChannel])

  const handleStopAndClose = () => {
    const player = audioRef.current
    if (player) {
      player.pause()
      player.load()
    }
    setIsPlaying(false)
    setIsClosing(true)
    setPlaybackTime(0)
  }

  const handleTogglePlayback = async () => {
    const player = audioRef.current
    if (!player) return

    if (isPlaying) {
      handleStopAndClose()
      return
    }

    try {
      await player.play()
      setIsPlaying(true)
      setError(null)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'The browser blocked playback.'
      setError(message)
    }
  }

  const isLive = !!status

  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-neutral-800 selection:text-white font-sans antialiased flex flex-col transition-colors duration-200">

      {/* Container */}
      <div className="w-full max-w-[500px] mx-auto px-6 py-12 flex flex-col gap-10 relative">

        {/* Header */}
        <header className="flex items-center justify-between border-b border-neutral-100 dark:border-neutral-900 pb-4">
          <span className="font-mono text-sm tracking-[0.2em] font-semibold lowercase">
            asmr
          </span>
          <div className="flex items-center gap-4">
            {globalUptime && (
              <span className="font-mono text-[10px] text-neutral-400 dark:text-neutral-500 mr-1 select-none">
                live: {globalUptime}
              </span>
            )}
            <a
              href="https://github.com/k-atusa/asmr"
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[10px] text-neutral-500 hover:text-foreground dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors"
            >
              [ github ]
            </a>
            <button
              onClick={cycleTheme}
              className="font-mono text-[10px] text-neutral-500 hover:text-foreground dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors cursor-pointer"
            >
              [ {theme} ]
            </button>
          </div>
        </header>

        {/* Playlist / Stations Tracklist (Always visible) */}
        <section className={`flex flex-col ${selectedChannel ? 'pb-32' : 'pb-8'}`}>
          {channels.map((chan, index) => {
            const chanStatus = findStatusForMount(rawPayload, chan.mount)
            const isChanLive = !!chanStatus
            const songTitle = chanStatus?.title
            const isSelected = selectedChannel?.mount === chan.mount

            return (
              <div
                key={chan.mount}
                className="w-full border-b border-neutral-100 dark:border-neutral-900/60 last:border-b-0 py-1"
              >
                <button
                  onClick={() => {
                    setIsClosing(false)
                    setSelectedChannel(chan)
                  }}
                  className={`w-full flex items-center justify-between py-2 px-3 rounded-lg transition-all duration-150 cursor-pointer ${isSelected
                    ? 'bg-neutral-200/70 dark:bg-neutral-900/70'
                    : 'hover:bg-neutral-100/80 dark:hover:bg-neutral-900/30'
                    }`}
                >
                  <div className="flex items-baseline gap-4 min-w-0">
                    <span className={`font-mono text-[11px] ${isSelected ? 'text-foreground font-semibold' : 'text-neutral-500 dark:text-neutral-400'}`}>
                      {(index + 1).toString().padStart(2, '0')}
                    </span>
                    <span className={`text-sm tracking-tight transition-colors ${isSelected ? 'text-foreground font-semibold' : 'text-neutral-600 hover:text-foreground dark:text-neutral-300 dark:hover:text-neutral-100'}`}>
                      {chan.name.toLowerCase()}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 min-w-0 pl-4">
                    {isChanLive && songTitle && (
                      <span className="text-[11px] font-mono text-neutral-500 dark:text-neutral-400 truncate max-w-[160px] sm:max-w-[200px]">
                        {songTitle}
                      </span>
                    )}
                  </div>
                </button>
              </div>
            )
          })}
        </section>

        {/* Global Connection / Status Alert */}
        {error && (
          <div className="p-3 border border-neutral-150 dark:border-neutral-900 bg-neutral-50/50 dark:bg-neutral-950/20 text-neutral-600 dark:text-neutral-300 rounded-lg flex items-start gap-3 font-mono text-[11px] leading-relaxed animate-in fade-in duration-200">
            <span className="h-1.5 w-1.5 rounded-full bg-neutral-400 mt-1.5 shrink-0" />
            <p>{error}</p>
          </div>
        )}
      </div>

      {/* Floating Mini Player Overlay */}
      {selectedChannel && (
        <div
          onAnimationEnd={() => {
            if (isClosing) {
              setSelectedChannel(null)
              setIsClosing(false)
            }
          }}
          className={`fixed bottom-6 left-1/2 -translate-x-1/2 w-[calc(100%-3rem)] max-w-[380px] bg-popover text-popover-foreground border border-border rounded-full shadow-lg overflow-hidden z-50 ${isClosing
            ? 'animate-out slide-out-to-bottom-[200px] fade-out duration-400 fill-mode-forwards'
            : 'animate-in slide-in-from-bottom-[200px] fade-in duration-200'
            }`}
        >
          <div className="flex items-center gap-4 py-2.5 px-4">

            {/* Track Info */}
            <div className="flex-col flex flex-1 min-w-0 justify-center relative">
              <MarqueeText className="text-[13px] font-semibold tracking-tight leading-tight">
                {isLive ? (nowPlayingTitle || status?.title || selectedChannel.name) : 'offline'}
              </MarqueeText>
              <div className="flex items-center justify-between text-[11px] text-muted-foreground mt-0.5 tracking-tight font-medium min-w-0">
                <span className="truncate">{selectedChannel.name.toLowerCase()}</span>
                {playbackTime > 0 && (
                  <span className="font-mono text-[10px] tabular-nums shrink-0 ml-2">
                    {formatPlaybackTime(playbackTime)}
                  </span>
                )}
              </div>
            </div>

            {/* Controls */}
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={handleTogglePlayback}
                disabled={!isLive}
                className="h-8 w-8 flex items-center justify-center rounded-full hover:bg-accent hover:text-accent-foreground text-foreground transition-colors disabled:opacity-50 cursor-pointer"
              >
                {isPlaying ? <Square className="h-4 w-4 fill-current" strokeWidth={0} /> : <Play className="h-4 w-4 fill-current" strokeWidth={0} />}
              </button>
            </div>
          </div>
        </div>
      )}

      {selectedChannel && (
        <audio
          ref={audioRef}
          src={streamPlayUrl}
          preload="none"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onTimeUpdate={(e) => setPlaybackTime(e.currentTarget.currentTime)}
        />
      )}
    </div>
  )
}

export default App
