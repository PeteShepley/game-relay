import { describe, expect, test } from 'vitest'
import { handleDisconnect, handleMessage } from './relay'
import { InMemoryRoomStore } from './store'
import { seedFrom } from './rooms'
import type { Send, WireMessage } from './protocol'

// Helpers that read the messages a handler wants delivered.
const only = (sends: Send[]): WireMessage => {
  expect(sends).toHaveLength(1)
  return sends[0].message
}
const messagesTo = (sends: Send[], connectionId: string): WireMessage[] =>
  sends.filter((s) => s.connectionId === connectionId).map((s) => s.message)

// Drive create + join and return the codes/tokens both players hold.
async function createAndJoin(store: InMemoryRoomStore) {
  const created = only(await handleMessage(store, 'connA', { kind: 'create', name: 'Ada', rnd: 111 }))
  if (created.kind !== 'created') throw new Error('expected created')
  const joinSends = await handleMessage(store, 'connB', {
    kind: 'join',
    code: created.code,
    name: 'Bo',
    rnd: 222,
  })
  const joined = messagesTo(joinSends, 'connB').find((m) => m.kind === 'joined')
  if (joined?.kind !== 'joined') throw new Error('expected joined')
  return { code: created.code, tokenA: created.token, tokenB: joined.token, joinSends }
}

describe('create', () => {
  test('returns a shareable code + token, and no start yet', async () => {
    const store = new InMemoryRoomStore()
    const message = only(await handleMessage(store, 'connA', { kind: 'create', name: 'Ada', rnd: 5 }))
    expect(message.kind).toBe('created')
    if (message.kind !== 'created') return
    expect(message.code).toMatch(/^[A-Z2-9]{6}$/)
    expect(message.token.length).toBeGreaterThan(20)
    // The creator is bound to seat a, waiting for an opponent.
    expect(await store.getConn('connA')).toEqual({ code: message.code, seat: 'a' })
  })
})

describe('join', () => {
  test('starts the game for both seats with the contributed seed and both names', async () => {
    const store = new InMemoryRoomStore()
    const { code, joinSends } = await createAndJoin(store)

    const startA = messagesTo(joinSends, 'connA').find((m) => m.kind === 'start')
    const startB = messagesTo(joinSends, 'connB').find((m) => m.kind === 'start')
    expect(startA).toBeDefined()
    expect(startA).toEqual(startB)
    if (startA?.kind !== 'start') return
    expect(startA.seed).toBe(seedFrom(111, 222))
    expect(startA.dealer).toBe('a')
    expect(startA.seats).toEqual({ creator: 'a', joiner: 'b' })
    expect(startA.names).toEqual({ a: 'Ada', b: 'Bo' })
    expect(await store.getConn('connB')).toEqual({ code, seat: 'b' })
  })

  test('an unknown code is rejected', async () => {
    const store = new InMemoryRoomStore()
    const message = only(
      await handleMessage(store, 'x', { kind: 'join', code: 'ZZZZZZ', name: 'Bo', rnd: 1 }),
    )
    expect(message).toEqual({ kind: 'error', reason: 'badCode' })
  })

  test('a second join is refused once the seat is claimed', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createAndJoin(store)
    const message = only(
      await handleMessage(store, 'connC', { kind: 'join', code, name: 'Cy', rnd: 3 }),
    )
    expect(message).toEqual({ kind: 'error', reason: 'roomFull' })
  })
})

describe('submit', () => {
  test('stamps monotonically, persists, and fans out to both seats', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createAndJoin(store)

    const first = await handleMessage(store, 'connA', {
      kind: 'submit',
      action: { type: 'startHand' },
    })
    expect(first.map((s) => s.connectionId).sort()).toEqual(['connA', 'connB'])
    expect(first[0].message).toEqual({ kind: 'action', seq: 1, action: { type: 'startHand' } })

    const second = await handleMessage(store, 'connB', {
      kind: 'submit',
      action: { type: 'passUpcard', seat: 'b' },
    })
    expect(only([second[0]])).toEqual({
      kind: 'action',
      seq: 2,
      action: { type: 'passUpcard', seat: 'b' },
    })
    expect(await store.readLog(code)).toHaveLength(2)
  })

  test('a submit from a stranger connection is ignored', async () => {
    const store = new InMemoryRoomStore()
    await createAndJoin(store)
    const sends = await handleMessage(store, 'ghost', {
      kind: 'submit',
      action: { type: 'startHand' },
    })
    expect(sends).toEqual([])
  })
})

describe('resyncRequest', () => {
  test('replays the full stamped log to the asker', async () => {
    const store = new InMemoryRoomStore()
    await createAndJoin(store)
    await handleMessage(store, 'connA', { kind: 'submit', action: { type: 'startHand' } })
    await handleMessage(store, 'connB', {
      kind: 'submit',
      action: { type: 'passUpcard', seat: 'b' },
    })

    const message = only(await handleMessage(store, 'connB', { kind: 'resyncRequest' }))
    expect(message.kind).toBe('resync')
    if (message.kind !== 'resync') return
    expect(message.log.map((s) => s.seq)).toEqual([1, 2])
    expect(message.names).toEqual({ a: 'Ada', b: 'Bo' })
  })

  test('with an empty log it sends start, not resync', async () => {
    const store = new InMemoryRoomStore()
    await createAndJoin(store)
    const message = only(await handleMessage(store, 'connA', { kind: 'resyncRequest' }))
    expect(message.kind).toBe('start')
  })
})

describe('reconnect', () => {
  test('a wrong token is refused', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createAndJoin(store)
    const message = only(
      await handleMessage(store, 'intruder', { kind: 'reconnect', code, token: 'nope' }),
    )
    expect(message).toEqual({ kind: 'error', reason: 'badToken' })
  })

  test('the right token reattaches a dropped seat and resyncs the log', async () => {
    const store = new InMemoryRoomStore()
    const { code, tokenB } = await createAndJoin(store)
    await handleMessage(store, 'connA', { kind: 'submit', action: { type: 'startHand' } })

    await handleDisconnect(store, 'connB')
    const message = only(
      await handleMessage(store, 'connB2', { kind: 'reconnect', code, token: tokenB }),
    )
    expect(message.kind).toBe('resync')
    if (message.kind !== 'resync') return
    expect(message.log.map((s) => s.seq)).toEqual([1])
    // The new socket now owns seat b.
    expect(await store.getConn('connB2')).toEqual({ code, seat: 'b' })
    const room = await store.getRoom(code)
    expect(room?.seatB?.conn).toBe('connB2')
    expect(room?.seatB?.connected).toBe(true)
  })

  test('a creator who reconnects before anyone joined gets the code back', async () => {
    const store = new InMemoryRoomStore()
    const created = only(
      await handleMessage(store, 'connA', { kind: 'create', name: 'Ada', rnd: 1 }),
    )
    if (created.kind !== 'created') return
    const message = only(
      await handleMessage(store, 'connA2', {
        kind: 'reconnect',
        code: created.code,
        token: created.token,
      }),
    )
    expect(message).toEqual({ kind: 'created', code: created.code, token: created.token })
  })
})

describe('disconnect / abandonment', () => {
  test('a single disconnect keeps the room and reserves the seat', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createAndJoin(store)
    await handleDisconnect(store, 'connB')
    const room = await store.getRoom(code)
    expect(room).not.toBeNull()
    expect(room?.seatB?.connected).toBe(false)
    expect(room?.seatA.connected).toBe(true)
  })

  test('when both seats drop the room is abandoned', async () => {
    const store = new InMemoryRoomStore()
    const { code } = await createAndJoin(store)
    await handleDisconnect(store, 'connB')
    await handleDisconnect(store, 'connA')
    expect(await store.getRoom(code)).toBeNull()
  })

  test('a creator who leaves before anyone joins abandons the room', async () => {
    const store = new InMemoryRoomStore()
    const created = only(
      await handleMessage(store, 'connA', { kind: 'create', name: 'Ada', rnd: 1 }),
    )
    if (created.kind !== 'created') return
    await handleDisconnect(store, 'connA')
    expect(await store.getRoom(created.code)).toBeNull()
  })

  test('a stale disconnect after a reconnect leaves the live seat alone', async () => {
    const store = new InMemoryRoomStore()
    const { code, tokenB } = await createAndJoin(store)
    await handleDisconnect(store, 'connB')
    await handleMessage(store, 'connB2', { kind: 'reconnect', code, token: tokenB })
    // The old socket's late close must not knock the reconnected seat out.
    await handleDisconnect(store, 'connB')
    const room = await store.getRoom(code)
    expect(room?.seatB?.conn).toBe('connB2')
    expect(room?.seatB?.connected).toBe(true)
  })
})
