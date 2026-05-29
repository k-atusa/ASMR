import { Socket } from 'net'

const LIQUIDSOAP_HOST = process.env.LIQUIDSOAP_HOST || 'localhost'
const LIQUIDSOAP_PORT = parseInt(process.env.LIQUIDSOAP_PORT || '1234', 10)
const LIQUIDSOAP_PASSWORD = process.env.LIQUIDSOAP_PASSWORD || ''
const COMMAND_TIMEOUT = 5000

const sendTelnetCommand = (command: string): Promise<string> => {
  return new Promise((resolve, reject) => {
    const socket = new Socket()
    let response = ''
    let resolved = false

    const cleanup = () => {
      if (!resolved) {
        resolved = true
        socket.destroy()
      }
    }

    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Connection to Liquidsoap timed out'))
    }, COMMAND_TIMEOUT)

    socket.connect(LIQUIDSOAP_PORT, LIQUIDSOAP_HOST, () => {
      // If password is set, send it first
      if (LIQUIDSOAP_PASSWORD) {
        socket.write(`${LIQUIDSOAP_PASSWORD}\n`)
      }
      socket.write(`${command}\n`)
      socket.write('quit\n')
    })

    socket.on('data', (data) => {
      response += data.toString()
    })

    socket.on('close', () => {
      clearTimeout(timeout)
      if (!resolved) {
        resolved = true
        resolve(response)
      }
    })

    socket.on('error', (err) => {
      clearTimeout(timeout)
      cleanup()
      reject(err)
    })
  })
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed. Use POST.' })
    return
  }

  const { command } = req.body as { command?: string }

  if (command !== 'skip') {
    res.status(400).json({ error: 'Invalid command. Use "skip".' })
    return
  }

  // Liquidsoap telnet command - adjust 'radio' to match your source name in .liq
  const telnetCommand = 'radio.skip'

  try {
    const response = await sendTelnetCommand(telnetCommand)
    res.status(200).json({ 
      success: true, 
      command,
      response: response.trim() 
    })
  } catch (error) {
    console.error('[api/liquidsoap-control] command failed:', error)
    const message = error instanceof Error ? error.message : 'Failed to send command to Liquidsoap'
    res.status(502).json({ error: message })
  }
}
