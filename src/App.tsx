import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const STATUS_URL = '/icecast-status'
const STREAM_FALLBACK_URL = '/icecast-stream'
const STREAM_DISPLAY_URL = (() => {
  const base = import.meta.env.ICECAST_BASE_URL?.trim().replace(/\/+$/, '')
  return base ? `${base}/stream` : ''
})()

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
  listenUrl: string | null
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

const normalizeStreamUrl = (candidate: string | null): string => {
  if (!candidate) {
    return STREAM_FALLBACK_URL
  }

  try {
    const parsed = resolveToUrl(candidate)
    const localhostHosts = ['localhost', '127.0.0.1', '::1', '0.0.0.0']
    if (localhostHosts.includes(parsed.hostname)) {
      return STREAM_FALLBACK_URL
    }

    if (parsed.protocol === 'http:') {
      parsed.protocol = 'https:'
    }

    return parsed.toString()
  } catch (error) {
    console.warn('Stream URL normalization failed, falling back to default stream.', error)
    return STREAM_FALLBACK_URL
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

const pickSource = (payload?: MaybeSource & { source?: MaybeSource | MaybeSource[] }): MaybeSource | null => {
  if (!payload) return null
  if (Array.isArray(payload.source)) {
    return payload.source[0] ?? payload
  }
  if (payload.source) {
    return payload.source
  }
  return payload
}

const extractStatus = (payload: IcecastPayload | undefined): StationStatus => {
  const base = payload?.icestats ?? payload?.icecast
  const source = pickSource(base)

  const rawTitle = source?.title ?? base?.title ?? 'Unidentified Broadcast'
  const listenUrl = normalizeStreamUrl(source?.listenurl ?? base?.listenurl ?? null)
  const streamStartIso = source?.stream_start_iso8601 ?? base?.stream_start_iso8601 ?? null

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

function App() {
  const [status, setStatus] = useState<StationStatus | null>(null)
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)
  const hasLoadedOnce = useRef(false)

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
      const parsed = extractStatus(payload)
      setStatus(parsed)
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
    }, 45000)

    return () => {
      controller.abort()
      window.clearInterval(intervalId)
    }
  }, [refreshStatus])

  useEffect(() => {
    const player = audioRef.current
    if (!player) return

    player.pause()
    player.load()
    setIsPlaying(false)
  }, [status?.listenUrl])

  const formattedStart = useMemo(() => {
    if (!status?.streamStartIso) return null
    const date = new Date(status.streamStartIso)
    if (Number.isNaN(date.getTime())) return null

    return formatFullTimestamp(date)
  }, [status?.streamStartIso])

  const liveDuration = useMemo(() => formatLiveDuration(status?.streamStartIso ?? null), [status?.streamStartIso])

  const updatedAtText = useMemo(() => {
    if (!lastUpdated) return 'Syncing data'
    return formatClockTime(lastUpdated)
  }, [lastUpdated])

  const handleTogglePlayback = async () => {
    const player = audioRef.current
    if (!player || !status?.listenUrl) {
      setError('Unable to locate a playable stream URL.')
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

      <section className="panel now-playing">
        <div className="now-playing__stack">
          <span className="chip live" aria-live="polite">
            {isPlaying ? 'Streaming now' : 'Monitoring'}
          </span>
          <p className="label">Now Playing</p>
          <h2>{status?.title ?? 'Retrieving the latest metadata...'}</h2>

          <div className="timing" aria-live="polite">
            <div>
              <span className="timing-label">Stream Started</span>
              <p>{formattedStart ?? 'Checking...'}</p>
            </div>
            <div>
              <span className="timing-label">On Air</span>
              <p>{liveDuration ?? '00m'}</p>
            </div>
          </div>
        </div>

        <div className="control-cluster">
          <button
            className="primary-control"
            onClick={handleTogglePlayback}
            disabled={!status?.listenUrl || loading}
          >
            {isPlaying ? 'Pause' : 'Play Live'}
          </button>
          <button className="secondary-control" onClick={handleManualRefresh} disabled={loading}>
            Refresh
          </button>
        </div>

        <audio
          ref={audioRef}
          src={status?.listenUrl ?? undefined}
          preload="none"
          crossOrigin="anonymous"
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => setIsPlaying(false)}
        />
      </section>

      <section className="panel diagnostics">
        <div className="stat-grid">
          <article className="stat-card">
            <p className="stat-label">Stream URL</p>
            {STREAM_DISPLAY_URL ? (
              <a href={STREAM_DISPLAY_URL} target="_blank" rel="noreferrer" className="stat-value">
                {STREAM_DISPLAY_URL}
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
            <p className="stat-value">{loading ? 'Loading…' : 'Ready'}</p>
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
  )
}

export default App
