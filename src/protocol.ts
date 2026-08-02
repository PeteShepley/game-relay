// The wire protocol, re-declared for the relay. The canonical definition
// lives in clients/web/src/protocol.ts; keep the two in sync (the monorepo
// has no shared package today). The relay never runs the engine, so it
// treats an Action as an opaque tagged object: it only stamps, stores, and
// fans out actions, never inspecting their contents.

export type Seat = 'a' | 'b'

export type Action = { readonly type: string; readonly [key: string]: unknown }

export interface Contract {
  readonly seed: number
  readonly dealer: Seat
  readonly seats: { readonly creator: Seat; readonly joiner: Seat }
  readonly names: { readonly a: string; readonly b: string }
}

export interface Stamped {
  readonly seq: number
  readonly action: Action
}

export type ErrorReason = 'badCode' | 'roomFull' | 'badToken'

export type WireMessage =
  // --- lobby (client -> server) ---
  | { kind: 'create'; name: string; rnd: number }
  | { kind: 'join'; code: string; name: string; rnd: number }
  | { kind: 'reconnect'; code: string; token: string }
  // --- lobby (server -> client) ---
  | { kind: 'created'; code: string; token: string }
  | { kind: 'joined'; token: string }
  | { kind: 'error'; reason: ErrorReason }
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
