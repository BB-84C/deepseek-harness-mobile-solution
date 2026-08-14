import net from 'node:net'
import { WSSocket, OP, encodeFrame } from './src/ws.js'

function makePair() {
  return new Promise((resolve) => {
    let clientSock
    const server = net.createServer((serverSock) => {
      resolve({ serverSock, clientSock, server })
    })
    server.listen(0, '127.0.0.1', () => {
      clientSock = net.connect(server.address().port, '127.0.0.1')
    })
  })
}

async function main() {
  const pair = await makePair()
  pair.serverSock.on('data', (d) => console.log('SERVER raw data', d.length, d.toString('hex')))
  pair.clientSock.on('data', (d) => console.log('CLIENT raw data', d.length, d.toString('hex')))
  const s = new WSSocket(pair.serverSock, { requireMasked: true, maskOutgoing: false })
  const c = new WSSocket(pair.clientSock, { maskOutgoing: true, requireMasked: false })
  s.on('error', (e) => console.log('s error', e.message))
  c.on('error', (e) => console.log('c error', e.message))
  s.on('close', (code, r) => console.log('s close', code, r))
  c.on('close', (code, r) => console.log('c close', code, r))
  s.on('ping', (d) => console.log('s got ping', d.toString()))
  s.on('pong', (d) => console.log('s got pong', d.toString()))
  c.on('pong', (d) => console.log('c got pong', d.toString()))
  c.on('ping', (d) => console.log('c got ping', d.toString()))

  await new Promise((r) => setTimeout(r, 100))
  console.log('client ping send:', c.ping('ping-client'))
  await new Promise((r) => setTimeout(r, 500))
  console.log('server ping send:', s.ping('ping-server'))
  await new Promise((r) => setTimeout(r, 500))

  pair.serverSock.destroy()
  pair.clientSock.destroy()
  pair.server.close()
  process.exit(0)
}

main()
