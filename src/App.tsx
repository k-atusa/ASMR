import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

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

  const [selectedChannel, setSelectedChannel] = useState<{ mount: string; name: string }>(() => channels[0] || { mount: 'stream', name: 'Live Stream' })

  // Derived current channel's status
  const status = useMemo(() => {
    return findStatusForMount(rawPayload, selectedChannel.mount)
  }, [rawPayload, selectedChannel.mount])

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
    if (!player) return

    player.pause()
    player.load()
    setIsPlaying(false)
    setPlaybackSeconds(0)
  }, [selectedChannel.mount])

  const formattedStart = useMemo(() => {
    if (!status?.streamStartIso) return null
    const date = new Date(status.streamStartIso)
    if (Number.isNaN(date.getTime())) return null

    return formatFullTimestamp(date)
  }, [status?.streamStartIso])

  const liveDuration = useMemo(() => formatLiveDuration(status?.streamStartIso ?? null), [status?.streamStartIso, liveClock])

  const streamDisplayUrl = useMemo(() => {
    const cleanMount = selectedChannel.mount.startsWith('/') ? selectedChannel.mount : `/${selectedChannel.mount}`
    return runtimeBaseUrl ? `${runtimeBaseUrl}${cleanMount}` : ''
  }, [runtimeBaseUrl, selectedChannel.mount])

  const streamPlayUrl = useMemo(() => {
    return status?.listenUrl || `/api/icecast-stream?mount=${encodeURIComponent(selectedChannel.mount)}`
  }, [status?.listenUrl, selectedChannel.mount])

  const updatedAtText = useMemo(() => {
    if (!lastUpdated) return 'Syncing data'
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

  const isLive = !!status

  return (
    <div className="app-shell">
      <header className="masthead">
        <p className="eyebrow">WEB RADIO</p>
        <h1>Icecast Live Monitor</h1>
        <p className="lede">
          Keep tabs on the latest Icecast metadata, see when each broadcast went live, and jump into the stream with a
          single click.
        </p>
      </header>

      <div className="main-layout">
        {/* Stations Sidebar */}
        <section className="panel stations-panel">
          <h3 className="section-title">Stations</h3>
          <div className="stations-list">
            {channels.map((chan) => {
              const isChanActive = selectedChannel.mount === chan.mount
              const songTitle = getChannelSongTitle(chan.mount)
              const isChanLive = !!songTitle

              return (
                <button
                  key={chan.mount}
                  className={`station-card ${isChanActive ? 'active' : ''} ${isChanLive ? 'live' : 'offline'}`}
                  onClick={() => setSelectedChannel(chan)}
                >
                  <div className="station-card__header">
                    <span className="station-name">{chan.name}</span>
                    <span className="station-badge">
                      {isChanLive ? 'LIVE' : 'OFFLINE'}
                    </span>
                  </div>
                  <p className="station-song">
                    {songTitle || 'Offline / Not Broadcasting'}
                  </p>
                </button>
              )
            })}
          </div>
        </section>

        {/* Player & Diagnostics Container */}
        <div className="content-stack">
          <section className="panel now-playing">
            <div className="now-playing__stack">
              <span className={`chip ${isLive ? 'live' : 'offline-chip'}`} aria-live="polite">
                {isLive ? (isPlaying ? 'Streaming now' : 'Monitoring') : 'Offline'}
              </span>
              <p className="label">Now Playing — {selectedChannel.name}</p>
              <h2>
                {isLive 
                  ? (status?.title || 'Retrieving the latest metadata...') 
                  : 'This station is currently offline.'}
              </h2>

              <div className="timing" aria-live="polite">
                <div>
                  <span className="timing-label">Stream Started</span>
                  <p>{isLive ? (formattedStart ?? 'Checking...') : '—'}</p>
                </div>
                <div>
                  <span className="timing-label">On Air</span>
                  <p>{isLive ? (liveDuration ?? '00m') : '—'}</p>
                </div>
              </div>
            </div>

            <div className="control-cluster">
              <div className="track-controls">
                <button
                  className="primary-control"
                  onClick={handleTogglePlayback}
                  disabled={loading}
                >
                  {!isLive 
                    ? 'Station Offline' 
                    : (isPlaying ? `Pause (${formatPlaybackTime(playbackSeconds)})` : 'Play Live')}
                </button>
                <button
                  className="track-control-btn"
                  onClick={handleNextTrack}
                  disabled={isSkipping || loading || !isLive}
                  title="Next Track"
                  aria-label="Next Track"
                >
                  <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                    <path d="M6 18l8.5-6L6 6v12zm10-12v12h2V6h-2z"/>
                  </svg>
                </button>
              </div>
              <button className="secondary-control" onClick={handleManualRefresh} disabled={loading || isSkipping}>
                {isSkipping ? 'Switching...' : 'Refresh'}
              </button>
            </div>

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
          </section>

          <section className="panel diagnostics">
            <div className="stat-grid">
              <article className="stat-card">
                <p className="stat-label">Stream URL</p>
                {streamDisplayUrl ? (
                  <a href={streamDisplayUrl} target="_blank" rel="noreferrer" className="stat-value">
                    {streamDisplayUrl}
                  </a>
                ) : (
                  <p className="stat-value muted">Configure ICECAST_BASE_URL to show this link.</p>
                )}
              </article>
              <article className="stat-card">
                <p className="stat-label">Last Sync</p>
                <p className="stat-value">{updatedAtText}</p>
              </article>
              <article className="stat-card">
                <p className="stat-label">Status</p>
                <p className="stat-value">{loading ? 'Loading…' : (isLive ? 'Active' : 'Offline')}</p>
              </article>
            </div>

            {loading && (
              <p className="status-line" aria-live="polite">
                Fetching Icecast status...
              </p>
            )}
            {error && (
              <p className="status-line error" role="alert">
                {error}
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}

export default App
