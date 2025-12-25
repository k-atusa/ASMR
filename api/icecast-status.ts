const fetchIcecastStatus = async (baseUrl: string, userAgent: string | undefined) => {
  const target = new URL('/status-json.xsl', baseUrl)
  return fetch(target.toString(), {
    headers: userAgent ? { 'user-agent': userAgent } : undefined,
  })
}

export default async function handler(req: any, res: any) {
  const upstreamBase = process.env.ICECAST_BASE_URL?.trim()
  if (!upstreamBase) {
    res.status(500).json({ error: 'ICECAST_BASE_URL is not configured on the server.' })
    return
  }

  try {
    const response = await fetchIcecastStatus(upstreamBase, req.headers['user-agent'] as string | undefined)
    res.status(response.status)

    const contentType = response.headers.get('content-type')
    if (contentType) {
      res.setHeader('content-type', contentType)
    }

    const body = await response.text()
    res.send(body)
  } catch (error) {
    console.error('[api/icecast-status] upstream request failed', error)
    res.status(502).json({ error: 'Unable to reach the Icecast status endpoint.' })
  }
}
