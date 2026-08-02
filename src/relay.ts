import { generateCode, generateToken, seedFrom } from './rooms'
import { CodeCollision } from './store'
import type { Room, RoomStore, SeatState } from './store'
import type { Action, Contract, Seat, Send, WireMessage } from './protocol'

// The relay core: a rules-ignorant sequencer. It owns room lifecycle, the
// per-room monotonic action order, and message fan-out, but never runs the
// game engine — illegal actions are stamped and fanned out anyway, and both
// clients reject them identically as deterministic no-ops (DESIGN.md). Every
// handler returns the messages to deliver; the adapter (Lambda or local ws
// harness) does the actual sending, so this module has no AWS imports.

const to = (connectionId: string, message: WireMessage): Send => ({ connectionId, message })

function contractOf(room: Room): Contract | null {
  if (room.seed === null || room.seatB === null) return null
  return {
    seed: room.seed,
    dealer: room.dealer,
    seats: { creator: 'a', joiner: 'b' },
    names: { a: room.seatA.name, b: room.seatB.name },
  }
}

function seatOf(room: Room, seat: Seat): SeatState | null {
  return seat === 'a' ? room.seatA : room.seatB
}

function withSeat(room: Room, seat: Seat, next: SeatState): Room {
  return seat === 'a' ? { ...room, seatA: next } : { ...room, seatB: next }
}

// The live connections a fan-out should reach: both seats that currently
// hold a socket.
function connectedConns(room: Room): string[] {
  const conns: string[] = []
  if (room.seatA.conn) conns.push(room.seatA.conn)
  if (room.seatB?.conn) conns.push(room.seatB.conn)
  return conns
}

// $connect has nothing to record — a connection is bound to a room only once
// it sends create/join/reconnect, so an idle socket that never plays leaves
// no room state behind.
export async function handleConnect(): Promise<Send[]> {
  return []
}

export async function handleMessage(
  store: RoomStore,
  connectionId: string,
  message: WireMessage,
): Promise<Send[]> {
  switch (message.kind) {
    case 'create':
      return create(store, connectionId, message.name, message.rnd)
    case 'join':
      return join(store, connectionId, message.code, message.name, message.rnd)
    case 'reconnect':
      return reconnect(store, connectionId, message.code, message.token)
    case 'submit':
      return submit(store, connectionId, message.action)
    case 'resyncRequest':
      return resync(store, connectionId)
    default:
      // created/joined/error/start/action/resync are server->client only; a
      // client never sends them, so there is nothing to do.
      return []
  }
}

async function create(
  store: RoomStore,
  connectionId: string,
  name: string,
  rnd: number,
): Promise<Send[]> {
  const seatA: SeatState = { conn: connectionId, name, token: generateToken(), connected: true }
  // Retry on the vanishingly rare code collision.
  let code = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    code = generateCode()
    const room: Room = { code, dealer: 'a', seed: null, rndCreator: rnd, seatA, seatB: null }
    try {
      await store.createRoom(room)
      break
    } catch (err) {
      if (err instanceof CodeCollision) {
        code = ''
        continue
      }
      throw err
    }
  }
  if (!code) throw new Error('could not allocate a room code')

  await store.putConn(connectionId, { code, seat: 'a' })
  // No `start` yet: the contract needs both players. The creator waits on the
  // code; `start` fans out to both when the joiner arrives.
  return [to(connectionId, { kind: 'created', code, token: seatA.token })]
}

async function join(
  store: RoomStore,
  connectionId: string,
  code: string,
  name: string,
  rnd: number,
): Promise<Send[]> {
  const room = await store.getRoom(code)
  if (!room) return [to(connectionId, { kind: 'error', reason: 'badCode' })]
  // The second seat is joinable only once. After that, coming back is a
  // reconnect (token-gated), never a fresh join — this is what stops a
  // stranger with the code from taking a disconnected player's seat.
  if (room.seatB !== null) return [to(connectionId, { kind: 'error', reason: 'roomFull' })]

  const seatB: SeatState = { conn: connectionId, name, token: generateToken(), connected: true }
  const seed = seedFrom(room.rndCreator, rnd)
  const joined: Room = { ...room, seed, seatB }
  await store.putRoom(joined)
  await store.putConn(connectionId, { code, seat: 'b' })

  const contract = contractOf(joined)!
  const start: WireMessage = { kind: 'start', ...contract }
  const sends: Send[] = [to(connectionId, { kind: 'joined', token: seatB.token })]
  for (const conn of connectedConns(joined)) sends.push(to(conn, start))
  return sends
}

async function reconnect(
  store: RoomStore,
  connectionId: string,
  code: string,
  token: string,
): Promise<Send[]> {
  const room = await store.getRoom(code)
  if (!room) return [to(connectionId, { kind: 'error', reason: 'badCode' })]

  const seat: Seat | null =
    room.seatA.token === token ? 'a' : room.seatB?.token === token ? 'b' : null
  if (!seat) return [to(connectionId, { kind: 'error', reason: 'badToken' })]

  const current = seatOf(room, seat)!
  const reattached = withSeat(room, seat, { ...current, conn: connectionId, connected: true })
  await store.putRoom(reattached)
  await store.putConn(connectionId, { code, seat })

  // Restore whatever state this player left: still in the lobby (no joiner
  // yet) -> re-announce the code; mid-game -> a full bootstrap from the log.
  const contract = contractOf(reattached)
  if (!contract) {
    return [to(connectionId, { kind: 'created', code, token })]
  }
  const log = await store.readLog(code)
  if (log.length === 0) return [to(connectionId, { kind: 'start', ...contract })]
  return [to(connectionId, { kind: 'resync', ...contract, log })]
}

async function submit(
  store: RoomStore,
  connectionId: string,
  action: Action,
): Promise<Send[]> {
  const ref = await store.getConn(connectionId)
  if (!ref) return []
  const room = await store.getRoom(ref.code)
  if (!room) return []

  // The sequencer stamps: an atomic per-room counter assigns the order, then
  // we persist before fanning out so a resync always sees a stamped action.
  const seq = await store.nextSeq(ref.code)
  const stamped = { seq, action }
  await store.appendLog(ref.code, stamped)

  const fanout: WireMessage = { kind: 'action', ...stamped }
  return connectedConns(room).map((conn) => to(conn, fanout))
}

async function resync(store: RoomStore, connectionId: string): Promise<Send[]> {
  const ref = await store.getConn(connectionId)
  if (!ref) return []
  const room = await store.getRoom(ref.code)
  if (!room) return []
  const contract = contractOf(room)
  if (!contract) return []
  const log = await store.readLog(ref.code)
  if (log.length === 0) return [to(connectionId, { kind: 'start', ...contract })]
  return [to(connectionId, { kind: 'resync', ...contract, log })]
}

// A socket closed. Mark that seat absent; if the other seat is also gone (or
// never filled) the room is abandoned and deleted immediately, per the rule
// "if both players disconnect the game is abandoned". A single disconnect
// keeps the seat reserved and rejoinable via its token.
export async function handleDisconnect(store: RoomStore, connectionId: string): Promise<Send[]> {
  const ref = await store.getConn(connectionId)
  await store.deleteConn(connectionId)
  if (!ref) return []

  const room = await store.getRoom(ref.code)
  if (!room) return []

  const current = seatOf(room, ref.seat)
  // A stale socket that a reconnect already replaced: leave the live seat be.
  if (!current || current.conn !== connectionId) return []

  const vacated = withSeat(room, ref.seat, { ...current, conn: null, connected: false })
  const other = seatOf(vacated, ref.seat === 'a' ? 'b' : 'a')
  const abandoned = other === null || !other.connected

  if (abandoned) {
    if (other?.conn) await store.deleteConn(other.conn)
    await store.deleteRoom(ref.code)
  } else {
    await store.putRoom(vacated)
  }
  return []
}
