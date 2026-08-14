// Minimal RFC 6455 WebSocket client — used by the test suite (and by the fake
// dsh instance in tests). Zero dependencies. Supports ws:// and wss://
// (wss:// skips certificate verification and is only meant for tests).

import net from 'node:net'
import tls from 'node:tls'
import { randomBytes } from 'node:crypto'
import { WSSocket, acceptKey } from './ws.js'

// Connect to a WebSocket URL and resolve with a ready WSSocket.
// `headers` are extra handshake headers (name -> value).
export function connect(url, headers = {}) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch (err) {
      reject(err)
      return
    }
    const secure = u.protocol === 'wss:'
    const port = u.port ? Number(u.port) : secure ? 443 : 80
    const host = u.hostname

    const socket = secure
      ? tls.connect({ host, port, rejectUnauthorized: false })
      : net.connect({ host, port })

    const key = randomBytes(16).toString('base64')
    const path = u.pathname + u.search
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${u.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
    ]
    for (const [name, value] of Object.entries(headers)) {
      lines.push(`${name}: ${value}`)
    }
    const requestHead = lines.join('\r\n') + '\r\n\r\n'

    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(err)
    }
    socket.on('error', fail)
    socket.on('close', () => {
      if (!settled) fail(new Error('WebSocket connection closed during handshake'))
    })

    socket.write(requestHead)

    let buffer = Buffer.alloc(0)
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const idx = buffer.indexOf('\r\n\r\n')
      if (idx === -1) return
      const headerText = buffer.subarray(0, idx).toString('latin1')
      const rest = buffer.subarray(idx + 4)
      socket.removeListener('data', onData)

      const [statusLine, ...headerLines] = headerText.split('\r\n')
      const status = parseInt(statusLine.split(' ')[1], 10)
      const respHeaders = {}
      for (const line of headerLines) {
        const c = line.indexOf(':')
        if (c === -1) continue
        respHeaders[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim()
      }
      if (status !== 101) {
        fail(new Error(`WebSocket handshake failed: ${statusLine}`))
        return
      }
      if (respHeaders['sec-websocket-accept'] !== acceptKey(key)) {
        fail(new Error('WebSocket handshake failed: bad Sec-WebSocket-Accept'))
        return
      }

      socket.removeListener('error', fail)
      socket.removeListener('close', fail)
      settled = true
      const ws = new WSSocket(socket, { maskOutgoing: true, requireMasked: false })
      if (rest.length) ws.feed(rest)
      resolve(ws)
    }
    socket.on('data', onData)
  })
}
