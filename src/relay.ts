import { MAX_SEATS, generateCode, generateToken, nextSeatId, seedFrom } from './rooms'
import { CodeCollision, StaleRoom } from './store'
import type { Room, RoomStore, SeatState } from './store'
import type { Action, Contract, Roster, SeatId, Send, WireMessage } from './protocol'

// The relay core: a rules-ignorant sequencer shared by every game. It owns
// room lifecycle, the per-room monotonic action order, and message fan-out,
// but never runs a game engine — illegal actions are stamped and fanned out
// anyway, and every client rejects them identically as deterministic no-ops.
// Every handler returns the messages to deliver; the adapter (Lambda or local
// ws harness) does the actual sending, so this module has no AWS imports.

const to = (connectionId: string, message: WireMessage): Send => ({ connectionId, message })

const GAME_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const MAX_NAME = 40

const started = (room: Room): boolean => room.seed !== null

function contractOf(room: Room): Contract | null {
  if (room.seed === null) return null
  return {
    game: room.game,
    seed: room.seed,
    dealer: room.seats[0].id,
    seats: room.seats.map(({ id, name, bot }) => (bot ? { id, name, bot } : { id, name })),
  }
}

function rosterOf(room: Room): Roster {
  return {
    seats: room.seats.map(({ id, name, connected, bot }) =>
      bot ? { id, name, connected, bot } : { id, name, connected },
    ),
    minSeats: room.minSeats,
    maxSeats: room.maxSeats,
    started: started(room),
  }
}

function withSeat(room: Room, id: SeatId, next: SeatState): Room {
  return { ...room, seats: room.seats.map((seat) => (seat.id === id ? next : seat)) }
}

// The live connections a fan-out should reach: every seat that currently
// holds a socket.
function connectedConns(room: Room): string[] {
  return room.seats.flatMap((seat) => (seat.conn ? [seat.conn] : []))
}

const broadcast = (room: Room, message: WireMessage): Send[] =>
  connectedConns(room).map((conn) => to(conn, message))

// Starting a room fixes the seed from every seat's contribution, in seat
// order, and sends each connected seat the contract.
function begin(room: Room): Room {
  return { ...room, seed: seedFrom(room.seats.map((seat) => seat.rnd)) }
}

// Read-modify-write a room under its version guard, retrying when another
// invocation got there first. `fn` returns the room to write (or null to
// write nothing) and the result to hand back once the write lands.
async function updateRoom<T>(
  store: RoomStore,
  code: string,
  fn: (room: Room) => { next: Room | null; result: T },
  missing: T,
): Promise<T> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const room = await store.getRoom(code)
    if (!room) return missing
    const { next, result } = fn(room)
    if (!next) return result
    try {
      await store.putRoom(next)
      return result
    } catch (err) {
      if (err instanceof StaleRoom) continue
      throw err
    }
  }
  throw new Error(`room ${code} kept changing under us`)
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
      return create(store, connectionId, message)
    case 'join':
      return join(store, connectionId, message)
    case 'reconnect':
      return reconnect(store, connectionId, message.code, message.token)
    case 'begin':
      return beginRequest(store, connectionId)
    case 'addBot':
      return addBot(store, connectionId, message.name, message.rnd)
    case 'removeBot':
      return removeBot(store, connectionId, message.seat)
    case 'submit':
      return submit(store, connectionId, message.action)
    case 'resyncRequest':
      return resync(store, connectionId)
    case 'ping':
      return [to(connectionId, { kind: 'pong' })]
    default:
      // Every other kind is server->client only; a client never sends them.
      return []
  }
}

function validSeats(minSeats: unknown, maxSeats: unknown): boolean {
  return (
    Number.isInteger(minSeats) &&
    Number.isInteger(maxSeats) &&
    (minSeats as number) >= 2 &&
    (minSeats as number) <= (maxSeats as number) &&
    (maxSeats as number) <= MAX_SEATS
  )
}

const cleanName = (name: unknown): string => String(name ?? '').trim().slice(0, MAX_NAME)

async function create(
  store: RoomStore,
  connectionId: string,
  message: Extract<WireMessage, { kind: 'create' }>,
): Promise<Send[]> {
  const { game, rnd, minSeats, maxSeats } = message
  if (typeof game !== 'string' || !GAME_ID.test(game) || !validSeats(minSeats, maxSeats)) {
    return [to(connectionId, { kind: 'error', reason: 'badRequest' })]
  }

  const creator: SeatState = {
    id: nextSeatId([]),
    conn: connectionId,
    name: cleanName(message.name),
    token: generateToken(),
    connected: true,
    rnd: rnd >>> 0,
  }
  // Retry on the vanishingly rare code collision.
  let room: Room | null = null
  for (let attempt = 0; attempt < 5 && !room; attempt++) {
    const candidate: Room = {
      code: generateCode(),
      game,
      minSeats,
      maxSeats,
      seed: null,
      seats: [creator],
      version: 0,
    }
    try {
      await store.createRoom(candidate)
      room = candidate
    } catch (err) {
      if (!(err instanceof CodeCollision)) throw err
    }
  }
  if (!room) throw new Error('could not allocate a room code')

  await store.putConn(connectionId, { code: room.code, seat: creator.id })
  // No `start` yet: the creator waits on the code until the room fills or
  // they send `begin`.
  return [
    to(connectionId, { kind: 'created', code: room.code, token: creator.token, seat: creator.id }),
    to(connectionId, { kind: 'roster', ...rosterOf(room) }),
  ]
}

async function join(
  store: RoomStore,
  connectionId: string,
  message: Extract<WireMessage, { kind: 'join' }>,
): Promise<Send[]> {
  const { code, game, rnd } = message
  const fail = (reason: Extract<WireMessage, { kind: 'error' }>['reason']) => ({
    next: null,
    result: [to(connectionId, { kind: 'error', reason })],
  })

  let seat: SeatState | null = null
  const sends = await updateRoom<Send[]>(
    store,
    code,
    (room) => {
      seat = null
      if (room.game !== game) return fail('wrongGame')
      // Seats are joinable only before the start. After that, coming back is
      // a reconnect (token-gated), never a fresh join — this is what stops a
      // stranger with the code from taking a disconnected player's seat.
      if (started(room)) return fail('alreadyStarted')
      if (room.seats.length >= room.maxSeats) return fail('roomFull')

      seat = {
        id: nextSeatId(room.seats.map((each) => each.id)),
        conn: connectionId,
        name: cleanName(message.name),
        token: generateToken(),
        connected: true,
        rnd: rnd >>> 0,
      }
      let next: Room = { ...room, seats: [...room.seats, seat] }
      // A full room starts on its own; otherwise the creator sends `begin`.
      if (next.seats.length === next.maxSeats) next = begin(next)

      const joined = to(connectionId, { kind: 'joined', code, token: seat.token, seat: seat.id })
      const contract = contractOf(next)
      return {
        next,
        result: [
          joined,
          ...broadcast(next, { kind: 'roster', ...rosterOf(next) }),
          ...(contract ? broadcast(next, { kind: 'start', ...contract }) : []),
        ],
      }
    },
    [to(connectionId, { kind: 'error', reason: 'badCode' })],
  )

  const claimed = seat as SeatState | null
  if (claimed) await store.putConn(connectionId, { code, seat: claimed.id })
  return sends
}

async function beginRequest(store: RoomStore, connectionId: string): Promise<Send[]> {
  const ref = await store.getConn(connectionId)
  if (!ref) return []
  const error = (reason: 'notCreator' | 'notEnoughPlayers') => ({
    next: null,
    result: [to(connectionId, { kind: 'error', reason })],
  })

  return updateRoom<Send[]>(
    store,
    ref.code,
    (room) => {
      if (ref.seat !== room.seats[0].id) return error('notCreator')
      // A late or duplicate begin after the start is harmless: ignore it.
      if (started(room)) return { next: null, result: [] }
      if (room.seats.length < room.minSeats) return error('notEnoughPlayers')
      const next = begin(room)
      return { next, result: broadcast(next, { kind: 'start', ...contractOf(next)! }) }
    },
    [],
  )
}

// The creator fills an empty seat with a computer player before the start.
// It takes the next free letter, counts toward minSeats like anyone, and
// never connects; a connected human's client plays it. Unlike a join, a
// bot filling the last seat does not start the room - the creator does.
async function addBot(store: RoomStore, connectionId: string, name: unknown, rnd: unknown): Promise<Send[]> {
  const ref = await store.getConn(connectionId)
  if (!ref) return []
  const fail = (reason: 'notCreator' | 'roomFull' | 'alreadyStarted') => ({
    next: null,
    result: [to(connectionId, { kind: 'error', reason })],
  })
  return updateRoom<Send[]>(
    store,
    ref.code,
    (room) => {
      if (ref.seat !== room.seats[0].id) return fail('notCreator')
      if (started(room)) return fail('alreadyStarted')
      if (room.seats.length >= room.maxSeats) return fail('roomFull')
      const bot: SeatState = {
        id: nextSeatId(room.seats.map((each) => each.id)),
        conn: null,
        name: cleanName(name),
        token: '',
        connected: false,
        rnd: Number(rnd) >>> 0,
        bot: true,
      }
      const next: Room = { ...room, seats: [...room.seats, bot] }
      return { next, result: broadcast(next, { kind: 'roster', ...rosterOf(next) }) }
    },
    [],
  )
}

// The creator takes a computer player back out, before the start.
async function removeBot(store: RoomStore, connectionId: string, seat: SeatId): Promise<Send[]> {
  const ref = await store.getConn(connectionId)
  if (!ref) return []
  return updateRoom<Send[]>(
    store,
    ref.code,
    (room) => {
      if (ref.seat !== room.seats[0].id) {
        return { next: null, result: [to(connectionId, { kind: 'error', reason: 'notCreator' })] }
      }
      const target = room.seats.find((each) => each.id === seat)
      // Only a bot, only in the lobby; anything else is a harmless no-op.
      if (started(room) || !target?.bot) return { next: null, result: [] }
      const next: Room = { ...room, seats: room.seats.filter((each) => each !== target) }
      return { next, result: broadcast(next, { kind: 'roster', ...rosterOf(next) }) }
    },
    [],
  )
}

async function reconnect(
  store: RoomStore,
  connectionId: string,
  code: string,
  token: string,
): Promise<Send[]> {
  let seatId: SeatId | null = null
  const sends = await updateRoom<Send[]>(
    store,
    code,
    (room) => {
      seatId = null
      // A computer player has no token and can never be reattached.
      const current = room.seats.find((seat) => !seat.bot && seat.token === token)
      if (!current) return { next: null, result: [to(connectionId, { kind: 'error', reason: 'badToken' })] }
      seatId = current.id

      const next = withSeat(room, current.id, { ...current, conn: connectionId, connected: true })
      const roster = broadcast(next, { kind: 'roster', ...rosterOf(next) })
      // Restore whatever state this player left: still in the lobby ->
      // re-announce the seat; mid-game -> a full bootstrap from the log
      // (the log is read after the write lands, below).
      if (!started(next)) {
        const kind = current.id === next.seats[0].id ? 'created' : 'joined'
        return { next, result: [to(connectionId, { kind, code, token, seat: current.id }), ...roster] }
      }
      return { next, result: roster }
    },
    [to(connectionId, { kind: 'error', reason: 'badCode' })],
  )
  const reattached = seatId as SeatId | null
  if (!reattached) return sends

  await store.putConn(connectionId, { code, seat: reattached })
  const bootstrap = await bootstrapFor(store, code, connectionId)
  return [...sends, ...bootstrap]
}

async function submit(store: RoomStore, connectionId: string, action: Action): Promise<Send[]> {
  const ref = await store.getConn(connectionId)
  if (!ref) return []
  const room = await store.getRoom(ref.code)
  if (!room || !started(room)) return []

  // The sequencer stamps: an atomic per-room counter assigns the order, then
  // we persist before fanning out so a resync always sees a stamped action.
  const seq = await store.nextSeq(ref.code)
  const stamped = { seq, action }
  await store.appendLog(ref.code, stamped)
  return broadcast(room, { kind: 'action', ...stamped })
}

async function resync(store: RoomStore, connectionId: string): Promise<Send[]> {
  const ref = await store.getConn(connectionId)
  if (!ref) return []
  return bootstrapFor(store, ref.code, connectionId)
}

// The fresh contract (no actions yet) or the contract + full log.
async function bootstrapFor(store: RoomStore, code: string, connectionId: string): Promise<Send[]> {
  const room = await store.getRoom(code)
  const contract = room && contractOf(room)
  if (!contract) return []
  const log = await store.readLog(code)
  if (log.length === 0) return [to(connectionId, { kind: 'start', ...contract })]
  return [to(connectionId, { kind: 'resync', ...contract, log })]
}

// A socket closed. Mark that seat absent; if no seat is still connected the
// room is abandoned and deleted immediately. Otherwise the seat stays
// reserved, rejoinable via its token, and everyone left sees the new roster.
export async function handleDisconnect(store: RoomStore, connectionId: string): Promise<Send[]> {
  const ref = await store.getConn(connectionId)
  await store.deleteConn(connectionId)
  if (!ref) return []

  let abandoned = false
  const sends = await updateRoom<Send[]>(
    store,
    ref.code,
    (room) => {
      abandoned = false
      const current = room.seats.find((seat) => seat.id === ref.seat)
      // A stale socket that a reconnect already replaced: leave the live seat be.
      if (!current || current.conn !== connectionId) return { next: null, result: [] }

      const next = withSeat(room, current.id, { ...current, conn: null, connected: false })
      abandoned = next.seats.every((seat) => !seat.connected)
      return { next, result: broadcast(next, { kind: 'roster', ...rosterOf(next) }) }
    },
    [],
  )

  if (abandoned) await store.deleteRoom(ref.code)
  return sends
}
