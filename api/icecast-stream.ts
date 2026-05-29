import { Readable } from 'node:stream'

const fetchIcecastStream = async (baseUrl: string, mount: string, userAgent: string | undefined) => {
  const cleanMount = mount.startsWith('/') ? mount : `/${mount}`
  const target = new URL(cleanMount, baseUrl)
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

  const url = new URL(req.url, 'http://localhost')
  const mount = req.query?.mount || url.searchParams.get('mount') || 'stream'

  try {
    const response = await fetchIcecastStream(upstreamBase, mount as string, req.headers['user-agent'] as string | undefined)
    res.status(response.status)

    response.headers.forEach((value, key) => {
      if (['transfer-encoding', 'content-length'].includes(key.toLowerCase())) {
        return
      }
      res.setHeader(key, value)
    })

    const length = response.headers.get('content-length')
    if (length) {
      res.setHeader('content-length', length)
    }

    if (!response.body) {
      res.end()
      return
    }

    Readable.fromWeb(response.body as any).pipe(res)
  } catch (error) {
    console.error('[api/icecast-stream] upstream request failed', error)
    res.status(502).json({ error: 'Unable to reach the Icecast stream endpoint.' })
  }
}
