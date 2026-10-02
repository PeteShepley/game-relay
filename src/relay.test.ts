import { describe, expect, test } from 'vitest'
import { handleDisconnect, handleMessage } from './relay'
import { InMemoryRoomStore, StaleRoom } from './store'
import type { Room } from './store'
import { seedFrom } from './rooms'
import type { Send, WireMessage } from './protocol'

// Helpers that read the messages a handler wants delivered.
const messagesTo = (sends: Send[], connectionId: string): WireMessage[] =>
  sends.filter((s) => s.connectionId === connectionId).map((s) => s.message)
const ofKind = <K extends WireMessage['kind']>(sends: Send[], connectionId: string, kind: K) =>
  messagesTo(sends, connectionId).find((m) => m.kind === kind) as
    | Extract<WireMessage, { kind: K }>
    | undefined

const create = (game = 'gin-rummy', minSeats = 2, maxSeats = 2, rnd = 111): WireMessage => ({
  kind: 'create',
  game,
  name: 'Ada',
  rnd,
  minSeats,
  maxSeats,
})

async function createRoom(store: InMemoryRoomStore, msg: WireMessage = create()) {
  const sends = await handleMessage(store, 'connA', msg)
  const created = ofKind(sends, 'connA', 'created')
  if (!created) throw new Error('expected created')
  return { code: created.code, tokenA: created.token, sends }
}

async function joinRoom(store: InMemoryRoomStore, code: string, conn: string, name: string, rnd: number, game = 'gin-rummy') {
  const sends = await handleMessage(store, conn, { kind: 'join', code, game, name, rnd })
  return { sends, joined: ofKind(sends, conn, 'joined') }
}

// The classic two-seat flow: create + join, which auto-starts.
async function createAndJoin(store: InMemoryRoomStore) {
  const { code, tokenA } = await createRoom(store)
  const { sends: joinSends, joined } = await joinRoom(store, code, 'connB', 'Bo', 222)
  if (!joined) throw new Error('expected joined')
  return { code, tokenA, tokenB: joined.token, joinSends }
}

describe('create', () => {
  test('returns a shareable code, token and seat a, plus a lobby roster', async () => {
    const store = new InMemoryRoomStore()
    const { code, sends } = await createRoom(store)
    expect(code).toMatch(/^[A-Z2-9]{6}$/)
    expect(ofKind(sends, 'connA', 'created')?.seat).toBe('a')
    expect(ofKind(sends, 'connA', 'created')?.token.length).toBeGreaterThan(20)
    expect(ofKind(sends, 'connA', 'roster')).toEqual({
      kind: 'roster',
      seats: [{ id: 'a', name: 'Ada', connected: true }],
      minSeats: 2,
      maxSeats: 2,
      started: false,
    })
    expect(ofKind(sends, 'connA', 'start')).toBeUndefined()
    expect(await store.getConn('connA')).toEqual({ code, seat: 'a' })
  })

  test.each([
    ['bad game id', create('Gin Rummy!')],
    ['min below 2', create('hearts', 1, 4)],
    ['min above max', create('hearts', 5, 4)],
    ['max above the cap', create('hearts', 2, 9)],
    ['fractional seats', create('hearts', 2.5, 4)],
  ])('rejects %s', async (_, msg) => {
    const store = new InMemoryRoomStore()
    expect(await handleMessage(store, 'connA', msg)).toEqual([
      { connectionId: 'connA', message: { kind: 'error', reason: 'badRequest' } },
    ])
  })
})

describe('join (two seats)', () => {
  test('a full room starts for both seats with the contributed seed and both names', async () => {
    const store = new InMemoryRoomStore()
    const { code, joinSends } = await createAndJoin(store)

    expect(ofKind(joinSends, 'connB', 'joined')).toMatchObject({ code, seat: 'b' })
    const startA = ofKind(joinSends, 'connA', 'start')
    const startB = ofKind(joinSends, 'connB', 'start')
    expect(startA).toEqual(startB)
    expect(startA).toEqual({
      kind: 'start',
      game: 'gin-rummy',
      seed: seedFrom([111, 222]),
      dealer: 'a',
      seats: [
        { id: 'a', name: 'Ada' },
        { id: 'b', name: 'Bo' },
      ],
    })
    expect(await store.getConn('connB')).toEqual({ code, seat: 'b' })
  })

  test('an unknown code is rejected', async () => {
    const store = new InMemoryRoomStore()
    const { sends } = await joinRoom(store, 'ZZZZZZ', 'x', 'Bo', 1)
    expect(messagesTo(sends, 'x')).toEqual([{ kind: 'error', reason: 'badCode' }])
  })

  test('a code from a different game is rejected', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createRoom(store)
    const { sends } = await joinRoom(store, code, 'x', 'Bo', 1, 'hearts')
    expect(messagesTo(sends, 'x')).toEqual([{ kind: 'error', reason: 'wrongGame' }])
    expect((await store.getRoom(code))?.seats).toHaveLength(1)
  })

  test('a join after the start is refused', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createAndJoin(store)
    const { sends } = await joinRoom(store, code, 'connC', 'Cy', 3)
    expect(messagesTo(sends, 'connC')).toEqual([{ kind: 'error', reason: 'alreadyStarted' }])
  })
})

describe('N seats', () => {
  test('seats letter in join order and the room auto-starts when full', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createRoom(store, create('hearts', 4, 4, 1))
    await joinRoom(store, code, 'connB', 'Bo', 2, 'hearts')
    const { sends: third, joined: c } = await joinRoom(store, code, 'connC', 'Cy', 3, 'hearts')
    expect(c?.seat).toBe('c')
    expect(ofKind(third, 'connA', 'start')).toBeUndefined()
    // Everyone already seated sees the new roster.
    expect(ofKind(third, 'connA', 'roster')?.seats.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(ofKind(third, 'connB', 'roster')).toBeDefined()

    const { sends: fourth } = await joinRoom(store, code, 'connD', 'Di', 4, 'hearts')
    for (const conn of ['connA', 'connB', 'connC', 'connD']) {
      const start = ofKind(fourth, conn, 'start')
      expect(start?.seed).toBe(seedFrom([1, 2, 3, 4]))
      expect(start?.seats.map((s) => s.id)).toEqual(['a', 'b', 'c', 'd'])
    }
  })

  test('filling the last seat starts the room, so a further join is refused', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createRoom(store, create('crazy-eights', 2, 3))
    await joinRoom(store, code, 'connB', 'Bo', 2, 'crazy-eights')
    const { sends: filled } = await joinRoom(store, code, 'connC', 'Cy', 3, 'crazy-eights')
    expect(ofKind(filled, 'connA', 'start')).toBeDefined()
    const { sends } = await joinRoom(store, code, 'connD', 'Di', 4, 'crazy-eights')
    expect(messagesTo(sends, 'connD')).toEqual([{ kind: 'error', reason: 'alreadyStarted' }])
  })

  test('the creator can begin once minSeats have joined', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createRoom(store, create('crazy-eights', 3, 6, 1))
    await joinRoom(store, code, 'connB', 'Bo', 2, 'crazy-eights')

    expect(await handleMessage(store, 'connA', { kind: 'begin' })).toEqual([
      { connectionId: 'connA', message: { kind: 'error', reason: 'notEnoughPlayers' } },
    ])

    await joinRoom(store, code, 'connC', 'Cy', 3, 'crazy-eights')
    expect(await handleMessage(store, 'connB', { kind: 'begin' })).toEqual([
      { connectionId: 'connB', message: { kind: 'error', reason: 'notCreator' } },
    ])

    const sends = await handleMessage(store, 'connA', { kind: 'begin' })
    expect(sends.map((s) => s.connectionId).sort()).toEqual(['connA', 'connB', 'connC'])
    expect(sends[0].message).toMatchObject({ kind: 'start', seed: seedFrom([1, 2, 3]) })

    // Started: a late joiner is turned away, and a second begin is a no-op.
    const { sends: late } = await joinRoom(store, code, 'connD', 'Di', 4, 'crazy-eights')
    expect(messagesTo(late, 'connD')).toEqual([{ kind: 'error', reason: 'alreadyStarted' }])
    expect(await handleMessage(store, 'connA', { kind: 'begin' })).toEqual([])
  })
})

describe('submit', () => {
  test('stamps monotonically, persists, and fans out to every seat', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createAndJoin(store)

    const first = await handleMessage(store, 'connA', { kind: 'submit', action: { type: 'startHand' } })
    expect(first.map((s) => s.connectionId).sort()).toEqual(['connA', 'connB'])
    expect(first[0].message).toEqual({ kind: 'action', seq: 1, action: { type: 'startHand' } })

    const second = await handleMessage(store, 'connB', {
      kind: 'submit',
      action: { type: 'passUpcard', seat: 'b' },
    })
    expect(second[0].message).toEqual({ kind: 'action', seq: 2, action: { type: 'passUpcard', seat: 'b' } })
    expect(await store.readLog(code)).toHaveLength(2)
  })

  test('a submit from a stranger connection is ignored', async () => {
    const store = new InMemoryRoomStore()
    await createAndJoin(store)
    expect(await handleMessage(store, 'ghost', { kind: 'submit', action: { type: 'startHand' } })).toEqual([])
  })

  test('a submit before the start is ignored', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createRoom(store)
    expect(await handleMessage(store, 'connA', { kind: 'submit', action: { type: 'startHand' } })).toEqual([])
    expect(await store.readLog(code)).toEqual([])
  })
})

describe('resyncRequest', () => {
  test('replays the full stamped log to the asker', async () => {
    const store = new InMemoryRoomStore()
    await createAndJoin(store)
    await handleMessage(store, 'connA', { kind: 'submit', action: { type: 'startHand' } })
    await handleMessage(store, 'connB', { kind: 'submit', action: { type: 'passUpcard', seat: 'b' } })

    const [only] = await handleMessage(store, 'connB', { kind: 'resyncRequest' })
    expect(only.message.kind).toBe('resync')
    if (only.message.kind !== 'resync') return
    expect(only.message.log.map((s) => s.seq)).toEqual([1, 2])
    expect(only.message.seats.map((s) => s.name)).toEqual(['Ada', 'Bo'])
  })

  test('with an empty log it sends start, not resync', async () => {
    const store = new InMemoryRoomStore()
    await createAndJoin(store)
    const sends = await handleMessage(store, 'connA', { kind: 'resyncRequest' })
    expect(sends.map((s) => s.message.kind)).toEqual(['start'])
  })
})

describe('reconnect', () => {
  test('a wrong token is refused', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createAndJoin(store)
    expect(await handleMessage(store, 'intruder', { kind: 'reconnect', code, token: 'nope' })).toEqual([
      { connectionId: 'intruder', message: { kind: 'error', reason: 'badToken' } },
    ])
  })

  test('the right token reattaches a dropped seat, tells the room, and resyncs the log', async () => {
    const store = new InMemoryRoomStore()
    const { code, tokenB } = await createAndJoin(store)
    await handleMessage(store, 'connA', { kind: 'submit', action: { type: 'startHand' } })

    await handleDisconnect(store, 'connB')
    const sends = await handleMessage(store, 'connB2', { kind: 'reconnect', code, token: tokenB })
    const resync = ofKind(sends, 'connB2', 'resync')
    expect(resync?.log.map((s) => s.seq)).toEqual([1])
    expect(ofKind(sends, 'connA', 'roster')?.seats.every((s) => s.connected)).toBe(true)
    // The new socket now owns seat b.
    expect(await store.getConn('connB2')).toEqual({ code, seat: 'b' })
    const room = await store.getRoom(code)
    expect(room?.seats[1]).toMatchObject({ conn: 'connB2', connected: true })
  })

  test('a creator who reconnects before the start gets the code back', async () => {
    const store = new InMemoryRoomStore()
    const { code, tokenA } = await createRoom(store)
    const sends = await handleMessage(store, 'connA2', { kind: 'reconnect', code, token: tokenA })
    expect(ofKind(sends, 'connA2', 'created')).toEqual({ kind: 'created', code, token: tokenA, seat: 'a' })
    expect(ofKind(sends, 'connA2', 'start')).toBeUndefined()
  })

  test('a joiner who reconnects in the lobby gets their seat back', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createRoom(store, create('hearts', 4, 4))
    const { joined } = await joinRoom(store, code, 'connB', 'Bo', 2, 'hearts')
    await handleDisconnect(store, 'connB')
    const sends = await handleMessage(store, 'connB2', { kind: 'reconnect', code, token: joined!.token })
    expect(ofKind(sends, 'connB2', 'joined')).toMatchObject({ seat: 'b' })
  })
})

describe('disconnect / abandonment', () => {
  test('a single disconnect keeps the room, reserves the seat, and tells the others', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createAndJoin(store)
    const sends = await handleDisconnect(store, 'connB')
    expect(ofKind(sends, 'connA', 'roster')?.seats).toEqual([
      { id: 'a', name: 'Ada', connected: true },
      { id: 'b', name: 'Bo', connected: false },
    ])
    const room = await store.getRoom(code)
    expect(room?.seats.map((s) => s.connected)).toEqual([true, false])
  })

  test('when every seat drops the room is abandoned', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createAndJoin(store)
    await handleDisconnect(store, 'connB')
    await handleDisconnect(store, 'connA')
    expect(await store.getRoom(code)).toBeNull()
  })

  test('a creator who leaves before anyone joins abandons the room', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createRoom(store)
    await handleDisconnect(store, 'connA')
    expect(await store.getRoom(code)).toBeNull()
  })

  test('a stale disconnect after a reconnect leaves the live seat alone', async () => {
    const store = new InMemoryRoomStore()
    const { code, tokenB } = await createAndJoin(store)
    await handleDisconnect(store, 'connB')
    await handleMessage(store, 'connB2', { kind: 'reconnect', code, token: tokenB })
    // The old socket's late close must not knock the reconnected seat out.
    await handleDisconnect(store, 'connB')
    const room = await store.getRoom(code)
    expect(room?.seats[1]).toMatchObject({ conn: 'connB2', connected: true })
  })
})

describe('ping', () => {
  test('answers pong to the sender only, with or without a room', async () => {
    const store = new InMemoryRoomStore()
    expect(await handleMessage(store, 'lonely', { kind: 'ping' })).toEqual([
      { connectionId: 'lonely', message: { kind: 'pong' } },
    ])
  })
})

describe('concurrent writes', () => {
  test('putRoom refuses a stale version', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createRoom(store)
    const read = (await store.getRoom(code)) as Room
    await store.putRoom(read)
    await expect(store.putRoom(read)).rejects.toBeInstanceOf(StaleRoom)
  })

  test('two racing joins both land in distinct seats', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createRoom(store, create('hearts', 4, 4))
    const [b, c] = await Promise.all([
      joinRoom(store, code, 'connB', 'Bo', 2, 'hearts'),
      joinRoom(store, code, 'connC', 'Cy', 3, 'hearts'),
    ])
    expect([b.joined?.seat, c.joined?.seat].sort()).toEqual(['b', 'c'])
    const room = await store.getRoom(code)
    expect(room?.seats.map((s) => s.name).sort()).toEqual(['Ada', 'Bo', 'Cy'])
  })
})
