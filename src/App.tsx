import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { SkipForward, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

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
const CONTROL_URL = '/api/liquidsoap-control'

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
  title: string
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

    // Force hostname, port, and protocol to match ICECAST_BASE_URL if configured!
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
        // ignore parsing error
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
    title: decodeEntities(rawTitle),
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

  const hours = Math.floor(diff / 3600000)
  const minutes = Math.floor((diff % 3600000) / 60000)

  const segments: string[] = []
  if (hours > 0) {
    segments.push(`${hours}h`)
  }
  segments.push(`${minutes.toString().padStart(2, '0')}m`)

  return segments.join(' ')
}

const formatFullTimestamp = (date: Date): string =>
  new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)

const formatClockTime = (date: Date): string =>
  new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)

const formatPlaybackTime = (seconds: number): string => {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const remainingSeconds = safeSeconds % 60

  const mm = minutes.toString().padStart(2, '0')
  const ss = remainingSeconds.toString().padStart(2, '0')

  if (hours > 0) {
    return `${hours}:${mm}:${ss}`
  }

  return `${minutes}:${ss}`
}

const App = () => {
  const [runtimeBaseUrl, setRuntimeBaseUrl] = useState(() => resolveBaseUrl())
  const [rawPayload, setRawPayload] = useState<IcecastPayload | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [liveClock, setLiveClock] = useState(() => Date.now())
  const [playbackSeconds, setPlaybackSeconds] = useState(0)
  const [isSkipping, setIsSkipping] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)
  const hasLoadedOnce = useRef(false)

  // Light/Dark Theme state
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    if (typeof window !== 'undefined') {
      return (localStorage.getItem('theme') as 'dark' | 'light') || 'dark'
    }
    return 'dark'
  })

  // Parse Channels list
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

  // Initially NULL (no channel selected) to show only header and playlist
  const [selectedChannel, setSelectedChannel] = useState<{ mount: string; name: string } | null>(null)

  // Synchronize system dark/light class
  useEffect(() => {
    const root = window.document.documentElement
    if (theme === 'dark') {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
    localStorage.setItem('theme', theme)
  }, [theme])

  // Derived current channel's status
  const status = useMemo(() => {
    if (!selectedChannel) return null
    return findStatusForMount(rawPayload, selectedChannel.mount)
  }, [rawPayload, selectedChannel])

  const getChannelSongTitle = useCallback((mount: string) => {
    const channelStatus = findStatusForMount(rawPayload, mount)
    return channelStatus?.title || null
  }, [rawPayload])

  useEffect(() => {
    setRuntimeBaseUrl(resolveBaseUrl())
  }, [])

  const refreshStatus = useCallback(async (signal?: AbortSignal) => {
    if (!hasLoadedOnce.current) {
      setLoading(true)
    }

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
      setLastUpdated(new Date())
      setError(null)
      hasLoadedOnce.current = true
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return
      }
      const message = err instanceof Error ? err.message : 'Something unexpected happened.'
      setError(message)
    } finally {
      if (!signal || !signal.aborted) {
        setLoading(false)
      }
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

  // When changing channel, pause player and load new source
  useEffect(() => {
    const player = audioRef.current
    if (!player || !selectedChannel) return

    player.pause()
    player.load()
    setIsPlaying(false)
    setPlaybackSeconds(0)
  }, [selectedChannel?.mount])

  const formattedStart = useMemo(() => {
    if (!status?.streamStartIso) return null
    const date = new Date(status.streamStartIso)
    if (Number.isNaN(date.getTime())) return null

    return formatFullTimestamp(date)
  }, [status?.streamStartIso])

  const liveDuration = useMemo(() => formatLiveDuration(status?.streamStartIso ?? null), [status?.streamStartIso, liveClock])

  const streamDisplayUrl = useMemo(() => {
    if (!selectedChannel) return ''
    const cleanMount = selectedChannel.mount.startsWith('/') ? selectedChannel.mount : `/${selectedChannel.mount}`
    return runtimeBaseUrl ? `${runtimeBaseUrl}${cleanMount}` : ''
  }, [runtimeBaseUrl, selectedChannel])

  const streamPlayUrl = useMemo(() => {
    if (!selectedChannel) return ''
    return status?.listenUrl || `/api/icecast-stream?mount=${encodeURIComponent(selectedChannel.mount)}`
  }, [status?.listenUrl, selectedChannel])

  const updatedAtText = useMemo(() => {
    if (!lastUpdated) return '—'
    return formatClockTime(lastUpdated)
  }, [lastUpdated])

  const handleTogglePlayback = async () => {
    const player = audioRef.current
    if (!player) {
      setError('Unable to locate an audio player.')
      return
    }

    if (isPlaying) {
      player.pause()
      setIsPlaying(false)
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

  const handleManualRefresh = () => {
    refreshStatus()
  }

  const handleNextTrack = async () => {
    if (isSkipping) return

    setIsSkipping(true)
    setError(null)

    try {
      const response = await fetch(CONTROL_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ command: 'skip' }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || `Command failed (${response.status})`)
      }

      setTimeout(() => {
        refreshStatus()
      }, 500)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to control playback'
      setError(message)
    } finally {
      setIsSkipping(false)
    }
  }

  // Handle going back (Deselects and resets player cleanly)
  const handleGoBack = () => {
    const player = audioRef.current
    if (player) {
      player.pause()
    }
    setIsPlaying(false)
    setPlaybackSeconds(0)
    setSelectedChannel(null)
  }

  const isLive = !!status

  return (
    <div className="min-h-screen bg-background text-foreground selection:bg-neutral-800 selection:text-white font-sans antialiased flex flex-col justify-center transition-colors duration-200">
      {/* Hyper-minimal Centered Device Frame */}
      <div
        key={selectedChannel ? selectedChannel.mount : 'list'}
        className="w-full max-w-[500px] mx-auto px-6 py-12 flex flex-col gap-10 animate-in fade-in duration-300"
      >

        {/* Simple Lowercase Header with Theme Toggle / Back Button */}
        <header className="flex items-center justify-between border-b border-neutral-100 dark:border-neutral-900 pb-4">
          {selectedChannel ? (
            <button
              onClick={handleGoBack}
              className="font-mono text-sm tracking-wide font-semibold lowercase cursor-pointer hover:text-neutral-500 dark:hover:text-neutral-400 transition-colors"
            >
              [ back ]
            </button>
          ) : (
            <span className="font-mono text-sm tracking-[0.2em] font-semibold lowercase">
              asmr
            </span>
          )}
          <div className="flex items-center gap-4">
            <button
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
              className="font-mono text-[10px] text-neutral-500 hover:text-foreground dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors cursor-pointer"
            >
              [ {theme === 'dark' ? 'light' : 'dark'} ]
            </button>
            <a
              href="https://github.com/k-atusa/asmr"
              target="_blank"
              rel="noreferrer"
              className="font-mono text-[10px] text-neutral-500 hover:text-foreground dark:text-neutral-400 dark:hover:text-neutral-200 transition-colors"
            >
              [ github ]
            </a>
          </div>
        </header>

        {/* Playlist / Stations Tracklist (Mode 1: Only displayed when no channel is selected) */}
        {!selectedChannel && (
          <section className="flex flex-col gap-2">
            {channels.map((chan, index) => {
              const songTitle = getChannelSongTitle(chan.mount)
              const isChanLive = !!songTitle

              return (
                <button
                  key={chan.mount}
                  onClick={() => setSelectedChannel(chan)}
                  className="w-full flex items-baseline justify-between py-2.5 border-b border-neutral-100 dark:border-neutral-900/60 group text-left transition-colors duration-100 cursor-pointer"
                >
                  <div className="flex items-baseline gap-4 min-w-0">
                    <span className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                      {(index + 1).toString().padStart(2, '0')}
                    </span>
                    <span className="text-sm tracking-tight text-neutral-600 hover:text-foreground dark:text-neutral-300 dark:hover:text-neutral-100 transition-colors">
                      {chan.name.toLowerCase()}
                    </span>
                  </div>

                  <div className="flex items-center gap-3 min-w-0 pl-4">
                    {isChanLive && (
                      <span className="text-[11px] font-mono text-neutral-500 dark:text-neutral-400 truncate max-w-[160px] sm:max-w-[200px]">
                        {songTitle}
                      </span>
                    )}
                    <span className={`h-1.5 w-1.5 rounded-full shrink-0 transition-all ${isChanLive
                      ? 'bg-neutral-300 dark:bg-neutral-700'
                      : 'bg-transparent border border-neutral-200 dark:border-neutral-800'
                      }`} />
                  </div>
                </button>
              )
            })}
          </section>
        )}

        {/* Playback Control Deck (Mode 2: Only displayed when a channel has been selected) */}
        {selectedChannel && (
          <section className="py-6 flex flex-col gap-6">
            <div className="flex items-center justify-between text-[11px] font-mono text-neutral-500 dark:text-neutral-400">
              <span className="flex items-center gap-1.5">
                <span>{selectedChannel.name.toLowerCase()}</span>
                <span>/</span>
                <span className={isLive ? 'text-foreground font-medium' : 'text-neutral-500 dark:text-neutral-400'}>
                  {isLive ? 'online' : 'offline'}
                </span>
              </span>
              {isLive && formattedStart && (
                <span>
                  started {formattedStart.split(' ')[1]} {liveDuration && `(${liveDuration})`}
                </span>
              )}
            </div>

            <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-foreground leading-snug min-h-[4rem] flex items-center">
              {isLive
                ? (status?.title || 'buffering metadata...')
                : 'station currently offline'}
            </h2>

            {/* Minimalist Live Stream Timeline */}
            {isLive && isPlaying && (
              <div className="flex items-center gap-4 py-1">
                <span className="font-mono text-[10px] text-neutral-600 dark:text-neutral-300">
                  {formatPlaybackTime(playbackSeconds)}
                </span>
                <div className="h-[1px] flex-1 bg-neutral-100 dark:bg-neutral-900 relative overflow-hidden">
                  <div className="absolute top-0 left-0 h-full w-1/3 bg-neutral-900 dark:bg-neutral-100 animate-pulse" />
                </div>
                <span className="font-mono text-[10px] text-neutral-500 dark:text-neutral-400 uppercase tracking-widest">
                  live
                </span>
              </div>
            )}

            {/* Minimal Action Row */}
            <div className="flex items-center justify-between mt-2">
              <div className="flex items-center gap-4">
                <Button
                  onClick={handleTogglePlayback}
                  disabled={!isLive}
                  variant="outline"
                  className="rounded-full border-neutral-200 dark:border-neutral-800 px-6 py-4 font-mono text-xs lowercase hover:bg-neutral-100 dark:hover:bg-neutral-900/60 transition-all cursor-pointer"
                >
                  {isPlaying ? 'pause' : 'play'}
                </Button>

                {isLive && (
                  <Button
                    onClick={handleNextTrack}
                    disabled={isSkipping}
                    variant="ghost"
                    size="icon"
                    className="rounded-full text-neutral-500 hover:text-foreground hover:bg-neutral-100 dark:hover:bg-neutral-900/60 cursor-pointer"
                  >
                    <SkipForward className="h-4 w-4" />
                  </Button>
                )}
              </div>

              <Button
                onClick={handleManualRefresh}
                disabled={loading}
                variant="ghost"
                className="font-mono text-xs text-neutral-500 hover:text-foreground dark:text-neutral-400 p-0 h-auto hover:bg-transparent cursor-pointer"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </section>
        )}

        {/* Global Connection / Status Alert */}
        {error && (
          <div className="p-3 border border-neutral-150 dark:border-neutral-900 bg-neutral-50/50 dark:bg-neutral-950/20 text-neutral-600 dark:text-neutral-300 rounded-lg flex items-start gap-3 font-mono text-[11px] leading-relaxed animate-in fade-in duration-200">
            <span className="h-1.5 w-1.5 rounded-full bg-neutral-400 mt-1.5 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {/* Clean, Faint Footer (Mode 2: Only displayed when a channel has been selected) */}
        {selectedChannel && (
          <footer className="border-t border-neutral-100 dark:border-neutral-900 pt-5 flex items-center justify-between text-[10px] font-mono text-neutral-500 dark:text-neutral-400 animate-in fade-in duration-300">
            <div className="flex items-center gap-1.5">
              <span>sync {updatedAtText}</span>
              <span>•</span>
              <span>{loading ? 'updating' : 'idle'}</span>
            </div>
            {streamDisplayUrl && (
              <a
                href={streamDisplayUrl}
                target="_blank"
                rel="noreferrer"
                className="hover:text-foreground underline underline-offset-4 hover:decoration-foreground decoration-neutral-300 dark:decoration-neutral-800"
              >
                mount: {selectedChannel.mount}
              </a>
            )}
          </footer>
        )}

      </div>

      {selectedChannel && (
        <audio
          ref={audioRef}
          src={streamPlayUrl}
          preload="none"
          crossOrigin="anonymous"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
          onTimeUpdate={(event) => setPlaybackSeconds(event.currentTarget.currentTime)}
        />
      )}
    </div>
  )
}

export default App
