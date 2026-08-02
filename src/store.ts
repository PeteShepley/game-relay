import {
  DynamoDBClient,
} from '@aws-sdk/client-dynamodb'
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb'
import type { Seat, Stamped } from './protocol'

// One seat's occupant. `conn` is the live connection id (null while the
// player is disconnected); `token` is the reconnection secret; `connected`
// tracks presence for the abandonment rule.
export interface SeatState {
  readonly conn: string | null
  readonly name: string
  readonly token: string
  readonly connected: boolean
}

// A room as the relay core sees it. The monotonic sequence counter is NOT
// here — it is a store-internal value bumped atomically by nextSeq(), so a
// full putRoom() (seat/presence updates) can never clobber a concurrent
// stamp. `seed` and `seatB` are null until the second player joins.
export interface Room {
  readonly code: string
  readonly dealer: Seat
  readonly seed: number | null
  readonly rndCreator: number
  readonly seatA: SeatState
  readonly seatB: SeatState | null
}

// Thrown by createRoom when the code is already taken, so the caller can
// retry with a fresh one.
export class CodeCollision extends Error {}

export interface ConnRef {
  readonly code: string
  readonly seat: Seat
}

// The persistence seam. The Lambda uses DynamoRoomStore; tests and the local
// dev harness use InMemoryRoomStore. Everything is async so the same relay
// core drives both.
export interface RoomStore {
  createRoom(room: Room): Promise<void>
  getRoom(code: string): Promise<Room | null>
  putRoom(room: Room): Promise<void>
  deleteRoom(code: string): Promise<void>
  nextSeq(code: string): Promise<number>
  appendLog(code: string, stamped: Stamped): Promise<void>
  readLog(code: string): Promise<Stamped[]>
  putConn(connectionId: string, ref: ConnRef): Promise<void>
  getConn(connectionId: string): Promise<ConnRef | null>
  deleteConn(connectionId: string): Promise<void>
}

// ---------------------------------------------------------------------------
// In-memory store (tests + local dev harness). Deep-clones on the way in and
// out so a stored Room can never be mutated by reference from the outside.
// ---------------------------------------------------------------------------

interface MemRoom {
  room: Room
  seq: number
  log: Stamped[]
}

export class InMemoryRoomStore implements RoomStore {
  private rooms = new Map<string, MemRoom>()
  private conns = new Map<string, ConnRef>()

  async createRoom(room: Room): Promise<void> {
    if (this.rooms.has(room.code)) throw new CodeCollision(room.code)
    this.rooms.set(room.code, { room: clone(room), seq: 0, log: [] })
  }

  async getRoom(code: string): Promise<Room | null> {
    const entry = this.rooms.get(code)
    return entry ? clone(entry.room) : null
  }

  async putRoom(room: Room): Promise<void> {
    const entry = this.rooms.get(room.code)
    if (!entry) throw new Error(`putRoom on unknown room ${room.code}`)
    entry.room = clone(room)
  }

  async deleteRoom(code: string): Promise<void> {
    this.rooms.delete(code)
  }

  async nextSeq(code: string): Promise<number> {
    const entry = this.rooms.get(code)
    if (!entry) throw new Error(`nextSeq on unknown room ${code}`)
    entry.seq += 1
    return entry.seq
  }

  async appendLog(code: string, stamped: Stamped): Promise<void> {
    const entry = this.rooms.get(code)
    if (!entry) throw new Error(`appendLog on unknown room ${code}`)
    entry.log.push(clone(stamped))
  }

  async readLog(code: string): Promise<Stamped[]> {
    const entry = this.rooms.get(code)
    return entry ? entry.log.map(clone) : []
  }

  async putConn(connectionId: string, ref: ConnRef): Promise<void> {
    this.conns.set(connectionId, { ...ref })
  }

  async getConn(connectionId: string): Promise<ConnRef | null> {
    const ref = this.conns.get(connectionId)
    return ref ? { ...ref } : null
  }

  async deleteConn(connectionId: string): Promise<void> {
    this.conns.delete(connectionId)
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

// ---------------------------------------------------------------------------
// DynamoDB store (production). Single table, keyed (PK, SK):
//   ROOM#<code> / META         -> room metadata + nextSeq counter
//   ROOM#<code> / SEQ#<padded>  -> one stamped action (the ordered log)
//   CONN#<connectionId> / CONN  -> reverse lookup for $disconnect
// TTL (`ttl`, epoch seconds) is a backstop that garbage-collects orphaned or
// never-joined rooms; live rooms are deleted eagerly on abandonment.
// ---------------------------------------------------------------------------

const TTL_SECONDS = 3 * 60 * 60

function ttl(): number {
  return Math.floor(Date.now() / 1000) + TTL_SECONDS
}

const roomPk = (code: string) => `ROOM#${code}`
const seqSk = (seq: number) => `SEQ#${String(seq).padStart(9, '0')}`
const connPk = (connectionId: string) => `CONN#${connectionId}`

export class DynamoRoomStore implements RoomStore {
  private doc: DynamoDBDocumentClient

  constructor(
    private table: string,
    client: DynamoDBClient = new DynamoDBClient({}),
  ) {
    this.doc = DynamoDBDocumentClient.from(client, {
      marshallOptions: { removeUndefinedValues: true },
    })
  }

  async createRoom(room: Room): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            PK: roomPk(room.code),
            SK: 'META',
            ...serializeRoom(room),
            nextSeq: 0,
            ttl: ttl(),
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      )
    } catch (err) {
      if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
        throw new CodeCollision(room.code)
      }
      throw err
    }
  }

  async getRoom(code: string): Promise<Room | null> {
    const result = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { PK: roomPk(code), SK: 'META' } }),
    )
    return result.Item ? deserializeRoom(result.Item) : null
  }

  async putRoom(room: Room): Promise<void> {
    // Targeted SET on the mutable fields only; nextSeq is left untouched so a
    // concurrent stamp is never rolled back. Every attribute name is aliased
    // so a DynamoDB reserved word can never break the expression.
    await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: roomPk(room.code), SK: 'META' },
        UpdateExpression:
          'SET #seed = :seed, #rnd = :rnd, #seatA = :seatA, #seatB = :seatB, #dealer = :dealer, #ttl = :ttl',
        ExpressionAttributeNames: {
          '#seed': 'seed',
          '#rnd': 'rndCreator',
          '#seatA': 'seatA',
          '#seatB': 'seatB',
          '#dealer': 'dealer',
          '#ttl': 'ttl',
        },
        ExpressionAttributeValues: {
          ':seed': room.seed,
          ':rnd': room.rndCreator,
          ':seatA': room.seatA,
          ':seatB': room.seatB,
          ':dealer': room.dealer,
          ':ttl': ttl(),
        },
      }),
    )
  }

  async deleteRoom(code: string): Promise<void> {
    // Delete META + every SEQ# item in the partition. Reverse CONN# items
    // live in other partitions and are removed by the relay core before it
    // asks to delete the room.
    const items = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': roomPk(code) },
        ProjectionExpression: 'PK, SK',
      }),
    )
    await Promise.all(
      (items.Items ?? []).map((item) =>
        this.doc.send(
          new DeleteCommand({ TableName: this.table, Key: { PK: item.PK, SK: item.SK } }),
        ),
      ),
    )
  }

  async nextSeq(code: string): Promise<number> {
    const result = await this.doc.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { PK: roomPk(code), SK: 'META' },
        UpdateExpression: 'ADD #nextSeq :one',
        ExpressionAttributeNames: { '#nextSeq': 'nextSeq' },
        ExpressionAttributeValues: { ':one': 1 },
        ReturnValues: 'UPDATED_NEW',
      }),
    )
    return Number(result.Attributes?.nextSeq)
  }

  async appendLog(code: string, stamped: Stamped): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: {
          PK: roomPk(code),
          SK: seqSk(stamped.seq),
          seq: stamped.seq,
          action: stamped.action,
          ttl: ttl(),
        },
      }),
    )
  }

  async readLog(code: string): Promise<Stamped[]> {
    const result = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :seq)',
        ExpressionAttributeValues: { ':pk': roomPk(code), ':seq': 'SEQ#' },
        ScanIndexForward: true,
      }),
    )
    return (result.Items ?? []).map((item) => ({
      seq: item.seq as number,
      action: item.action as Stamped['action'],
    }))
  }

  async putConn(connectionId: string, ref: ConnRef): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { PK: connPk(connectionId), SK: 'CONN', code: ref.code, seat: ref.seat, ttl: ttl() },
      }),
    )
  }

  async getConn(connectionId: string): Promise<ConnRef | null> {
    const result = await this.doc.send(
      new GetCommand({ TableName: this.table, Key: { PK: connPk(connectionId), SK: 'CONN' } }),
    )
    return result.Item ? { code: result.Item.code, seat: result.Item.seat } : null
  }

  async deleteConn(connectionId: string): Promise<void> {
    await this.doc.send(
      new DeleteCommand({ TableName: this.table, Key: { PK: connPk(connectionId), SK: 'CONN' } }),
    )
  }
}

function serializeRoom(room: Room) {
  return {
    code: room.code,
    dealer: room.dealer,
    seed: room.seed,
    rndCreator: room.rndCreator,
    seatA: room.seatA,
    seatB: room.seatB,
  }
}

function deserializeRoom(item: Record<string, unknown>): Room {
  return {
    code: item.code as string,
    dealer: item.dealer as Seat,
    seed: (item.seed as number | null) ?? null,
    rndCreator: item.rndCreator as number,
    seatA: item.seatA as SeatState,
    seatB: (item.seatB as SeatState | null) ?? null,
  }
}
