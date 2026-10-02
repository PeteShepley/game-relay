// The wire protocol between a game client and the relay. This file is the
// canonical definition: games import it as `@peteshepley/game-relay/protocol`
// rather than re-declaring it. It holds types only — no runtime values — so
// any consumer (CommonJS here, ESM in the games) can import it. The relay
// never runs a game engine, so an Action is an opaque tagged object: it only
// stamps, stores, and fans out actions, never inspecting their contents.

// Seats are lettered in join order: the creator is 'a', the next player 'b',
// and so on. A two-player game therefore sees exactly the 'a' | 'b' it had
// when the relay was gin-rummy-only.
export type SeatId = string

export type Action = { readonly type: string; readonly [key: string]: unknown }

export interface SeatInfo {
  readonly id: SeatId
  readonly name: string
}

// The hand contract every client builds its initial state from. `seats` is
// in seat order; `dealer` is always the creator's seat.
export interface Contract {
  readonly game: string
  readonly seed: number
  readonly dealer: SeatId
  readonly seats: readonly SeatInfo[]
}

export interface RosterSeat extends SeatInfo {
  readonly connected: boolean
}

// Who is in the room. Broadcast whenever a seat fills, drops, or comes back,
// both before the game starts (the lobby) and during it (presence).
export interface Roster {
  readonly seats: readonly RosterSeat[]
  readonly minSeats: number
  readonly maxSeats: number
  readonly started: boolean
}

export interface Stamped {
  readonly seq: number
  readonly action: Action
}

export type ErrorReason =
  | 'badCode' // no such room
  | 'roomFull' // every seat is taken
  | 'alreadyStarted' // the game began before this join
  | 'wrongGame' // the code belongs to a different game
  | 'badToken' // reconnect token doesn't match any seat
  | 'badRequest' // malformed create (game id, seat bounds)
  | 'notCreator' // only seat 'a' may begin
  | 'notEnoughPlayers' // begin before minSeats have joined

export type WireMessage =
  // --- lobby (client -> server) ---
  | { kind: 'create'; game: string; name: string; rnd: number; minSeats: number; maxSeats: number }
  | { kind: 'join'; code: string; game: string; name: string; rnd: number }
  | { kind: 'reconnect'; code: string; token: string }
  | { kind: 'begin' }
  // --- lobby (server -> client) ---
  | { kind: 'created'; code: string; token: string; seat: SeatId }
  | { kind: 'joined'; code: string; token: string; seat: SeatId }
  | ({ kind: 'roster' } & Roster)
  | { kind: 'error'; reason: ErrorReason }
  // --- keepalive (API Gateway drops a socket idle for ~10 minutes) ---
  | { kind: 'ping' }
  | { kind: 'pong' }
  // --- game relay ---
  | ({ kind: 'start' } & Contract)
  | { kind: 'submit'; action: Action }
  | ({ kind: 'action' } & Stamped)
  | { kind: 'resyncRequest' }
  | ({ kind: 'resync' } & Contract & { readonly log: readonly Stamped[] })

// What the relay core asks the adapter to deliver: a message to one
// connection. The Lambda posts these via the API Gateway Management API; the
// local harness writes them straight to the matching WebSocket.
export interface Send {
  readonly connectionId: string
  readonly message: WireMessage
}
