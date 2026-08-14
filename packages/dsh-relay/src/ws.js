// Minimal RFC 6455 WebSocket implementation — server side.
// Zero dependencies. Supports text/binary frames, fragmentation, ping/pong,
// close handshake. No permessage-deflate, no extensions, no compression.

import { EventEmitter } from 'node:events'
import { createHash, randomBytes } from 'node:crypto'

// The magic GUID from RFC 6455 §1.3.
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

// Frame opcodes (RFC 6455 §5.2).
export const OP = {
  CONT: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
}

// Sanity cap on a single frame payload (guards against a malicious length header).
// Relay bodies are base64 of <=4 MB requests, so this is far above real traffic.
const MAX_FRAME_PAYLOAD = 64 * 1024 * 1024

// Compute the Sec-WebSocket-Accept value for a Sec-WebSocket-Key (RFC 6455 §4.2.2).
export function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64')
}

function applyMask(buf, maskKey) {
  for (let i = 0; i < buf.length; i++) buf[i] ^= maskKey[i & 3]
  return buf
}

// Encode a single WebSocket frame (RFC 6455 §5.2).
export function encodeFrame(opcode, payload, { fin = true, mask = false } = {}) {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload == null ? '' : String(payload))
  let headerLen
  if (body.length < 126) headerLen = 2
  else if (body.length < 65536) headerLen = 4
  else headerLen = 10
  if (mask) headerLen += 4

  const header = Buffer.alloc(headerLen)
  header[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f)
  if (body.length < 126) {
    header[1] = (mask ? 0x80 : 0x00) | body.length
  } else if (body.length < 65536) {
    header[1] = (mask ? 0x80 : 0x00) | 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header[1] = (mask ? 0x80 : 0x00) | 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }

  if (mask) {
    const maskKey = randomBytes(4)
    header.set(maskKey, headerLen - 4)
    return Buffer.concat([header, applyMask(Buffer.from(body), maskKey)])
  }
  return Buffer.concat([header, body])
}

// A WebSocket connection wrapping a raw duplex socket.
//
// Options:
//   maskOutgoing  - mask frames this endpoint sends (true for a client).
//   requireMasked - require incoming frames to be masked (true for a server).
//
// Events:
//   'message' (payload: Buffer, isBinary: boolean)
//   'ping'    (payload: Buffer)
//   'pong'    (payload: Buffer)
//   'close'   (code: number, reason: string)
//   'error'   (err: Error) — only emitted if a listener is attached.
export class WSSocket extends EventEmitter {
  constructor(socket, { maskOutgoing = false, requireMasked = false } = {}) {
    super()
    this.socket = socket
    this.maskOutgoing = maskOutgoing
    this.requireMasked = requireMasked
    this._buffer = Buffer.alloc(0)
    this._fragOpcode = null
    this._fragments = []
    this._closed = false
    this._closeSent = false
    this._closeEmitted = false
    this.lastError = null

    socket.on('data', (chunk) => this.feed(chunk))
    socket.on('error', (err) => {
      this.lastError = err
      if (this.listenerCount('error') > 0) this.emit('error', err)
    })
    socket.on('close', () => this._onTransportClose())
  }

  // Feed raw bytes into the parser.
  feed(chunk) {
    if (this._closed) return
    this._buffer = this._buffer.length === 0
      ? Buffer.from(chunk)
      : Buffer.concat([this._buffer, chunk])
    this._parse()
  }

  _parse() {
    while (true) {
      if (this._closed) return
      const buf = this._buffer
      if (buf.length < 2) return

      const b0 = buf[0]
      const b1 = buf[1]
      const fin = (b0 & 0x80) !== 0
      const rsv = b0 & 0x70
      const opcode = b0 & 0x0f
      const masked = (b1 & 0x80) !== 0
      let len = b1 & 0x7f
      let offset = 2

      if (rsv !== 0) {
        this._fail(1002, 'reserved bits must be zero (no extensions supported)')
        return
      }
      if (this.requireMasked && !masked) {
        this._fail(1002, 'client frames must be masked')
        return
      }

      if (len === 126) {
        if (buf.length < offset + 2) return
        len = buf.readUInt16BE(offset)
        offset += 2
      } else if (len === 127) {
        if (buf.length < offset + 8) return
        const big = buf.readBigUInt64BE(offset)
        offset += 8
        if (big > BigInt(MAX_FRAME_PAYLOAD)) {
          this._fail(1009, 'frame payload too large')
          return
        }
        len = Number(big)
      }

      let maskKey = null
      if (masked) {
        if (buf.length < offset + 4) return
        maskKey = buf.slice(offset, offset + 4)
        offset += 4
      }

      if (buf.length < offset + len) return

      let payload = buf.subarray(offset, offset + len)
      if (masked) {
        payload = applyMask(Buffer.from(payload), maskKey)
      }
      this._buffer = buf.subarray(offset + len)

      this._handleFrame({ fin, opcode, payload })
    }
  }

  _handleFrame({ fin, opcode, payload }) {
    switch (opcode) {
      case OP.CONT: {
        if (this._fragOpcode === null) {
          this._fail(1002, 'unexpected continuation frame')
          return
        }
        this._fragments.push(payload)
        if (fin) {
          const message = Buffer.concat(this._fragments)
          const wasBinary = this._fragOpcode === OP.BINARY
          this._fragOpcode = null
          this._fragments = []
          this.emit('message', message, wasBinary)
        }
        break
      }
      case OP.TEXT:
      case OP.BINARY: {
        if (this._fragOpcode !== null) {
          this._fail(1002, 'new data frame during fragmented message')
          return
        }
        if (fin) {
          this.emit('message', payload, opcode === OP.BINARY)
        } else {
          this._fragOpcode = opcode
          this._fragments = [payload]
        }
        break
      }
      case OP.PING: {
        this.pong(payload)
        this.emit('ping', payload)
        break
      }
      case OP.PONG: {
        this.emit('pong', payload)
        break
      }
      case OP.CLOSE: {
        this._handleClose(payload)
        break
      }
      default: {
        this._fail(1002, 'unknown opcode ' + opcode)
      }
    }
  }

  _handleClose(payload) {
    let code = 1005
    let reason = ''
    if (payload.length >= 2) code = payload.readUInt16BE(0)
    if (payload.length > 2) reason = payload.slice(2).toString('utf8')

    if (!this._closeSent) {
      this._closeSent = true
      this._closed = true
      try {
        const echo = payload.length >= 2 ? payload : Buffer.alloc(0)
        this.socket.write(encodeFrame(OP.CLOSE, echo, { fin: true, mask: this.maskOutgoing }))
      } catch {
        /* ignore */
      }
      this.socket.end()
    } else {
      this.socket.destroy()
    }
    this._emitClose(code, reason)
  }

  _onTransportClose() {
    if (this._closed) this._closed = true
    this._emitClose(1006, '')
  }

  _emitClose(code, reason) {
    if (this._closeEmitted) return
    this._closeEmitted = true
    this.emit('close', code, reason)
  }

  _fail(code, reason) {
    if (this._closed) return
    this._closed = true
    this.close(code, reason)
    this._emitClose(code, reason)
    const err = new Error(reason)
    err.wsCode = code
    if (this.listenerCount('error') > 0) this.emit('error', err)
  }

  send(data, { opcode = OP.TEXT, fin = true } = {}) {
    if (this._closed) return false
    try {
      this.socket.write(encodeFrame(opcode, data, { fin, mask: this.maskOutgoing }))
      return true
    } catch {
      return false
    }
  }

  sendText(data) {
    return this.send(data, { opcode: OP.TEXT })
  }

  sendBinary(data) {
    return this.send(data, { opcode: OP.BINARY })
  }

  ping(payload = Buffer.alloc(0)) {
    return this.send(payload, { opcode: OP.PING })
  }

  pong(payload = Buffer.alloc(0)) {
    return this.send(payload, { opcode: OP.PONG })
  }

  close(code = 1000, reason = '') {
    if (this._closeSent) return
    this._closeSent = true
    this._closed = true
    try {
      const reasonBuf = Buffer.from(String(reason), 'utf8').subarray(0, 123)
      const payload = Buffer.alloc(2 + reasonBuf.length)
      payload.writeUInt16BE(code, 0)
      reasonBuf.copy(payload, 2)
      this.socket.write(encodeFrame(OP.CLOSE, payload, { fin: true, mask: this.maskOutgoing }))
    } catch {
      /* ignore */
    }
    this.socket.end()
  }
}
