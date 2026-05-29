export default async function handler(req: any, res: any) {
  const { channel } = req.query
  const upstreamBase = process.env.ICECAST_BASE_URL?.trim()
  if (!upstreamBase) {
    res.status(500).json({ error: 'ICECAST_BASE_URL is not configured on the server.' })
    return
  }

  if (!channel) {
    res.status(400).json({ error: 'Channel name is required.' })
    return
  }

  try {
    const target = `${upstreamBase}/api/nowplaying/${channel}`
    const response = await fetch(target, {
      headers: req.headers['user-agent'] ? { 'user-agent': req.headers['user-agent'] } : undefined,
    })

    res.status(response.status)
    const contentType = response.headers.get('content-type')
    if (contentType) {
      res.setHeader('content-type', contentType)
    }

    const body = await response.text()
    res.send(body)
  } catch (error) {
    console.error('[api/nowplaying] upstream request failed', error)
    res.status(502).json({ error: 'Unable to reach the Now Playing endpoint.' })
  }
}
