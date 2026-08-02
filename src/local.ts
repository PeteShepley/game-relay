import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import { handleDisconnect, handleMessage } from './relay'
import { InMemoryRoomStore } from './store'
import type { Send, WireMessage } from './protocol'

// A dev-only relay: the SAME core (relay.ts) driven by the in-memory store,
// exposed over a plain WebSocket server. Point the web client at
// VITE_WS_URL=ws://localhost:8787 and two browsers get real networked play —
// rooms, codes, names, stamping, resync, reconnect, abandonment — with no
// AWS. This is to the relay what the BroadcastChannel loopback is to two
// tabs: the protocol, exercised early.

const port = Number(process.env.PORT ?? 8787)
const store = new InMemoryRoomStore()
const sockets = new Map<string, WebSocket>()

const wss = new WebSocketServer({ port })

wss.on('connection', (socket: WebSocket) => {
  const connectionId = randomUUID()
  sockets.set(connectionId, socket)

  socket.on('message', async (data) => {
    let message: WireMessage
    try {
      message = JSON.parse(data.toString()) as WireMessage
    } catch {
      return
    }
    deliver(await handleMessage(store, connectionId, message))
  })

  socket.on('close', async () => {
    sockets.delete(connectionId)
    deliver(await handleDisconnect(store, connectionId))
  })
})

function deliver(sends: Send[]): void {
  for (const send of sends) {
    const socket = sockets.get(send.connectionId)
    if (socket && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(send.message))
    }
  }
}

console.log(`gin-rummy relay (local) listening on ws://localhost:${port}`)
