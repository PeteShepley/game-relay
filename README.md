# Gin Rummy Relay Service

The room **sequencer** for networked play: an AWS API Gateway **WebSocket** API
backed by a Lambda. It is deliberately rules-ignorant — it never runs the game
engine. It owns three things (DESIGN.md's locked relay invariants + the room
lifecycle):

1. **Rooms** — create/join by short code, per-seat reconnection tokens, and the
   "abandoned when both players disconnect" rule.
2. **Action order** — each submitted action gets a per-room, monotonically
   increasing sequence number, then is fanned out to both seats. Illegal
   actions are stamped and fanned out anyway; both clients reject them
   identically as deterministic no-ops.
3. **Bootstrap** — `start` (fresh contract) and `resync` (contract + full log)
   so a joining or reconnecting client rebuilds from scratch.

The wire protocol is the one the loopback dev transport already speaks; see
`clients/web/src/protocol.ts` (canonical) and `src/protocol.ts` (re-declared).

## Layout

- `src/relay.ts` — the core: `handleConnect` / `handleDisconnect` /
  `handleMessage(store, connectionId, message) -> Send[]`. No AWS imports.
- `src/store.ts` — the `RoomStore` seam: `InMemoryRoomStore` (tests + local dev)
  and `DynamoRoomStore` (production, single-table `gin-rummy-rooms`).
- `src/rooms.ts` — pure helpers: room-code / token generation, contributed-seed
  hashing.
- `src/handler.ts` — the Lambda entry: routes `$connect` / `$disconnect` /
  `$default`, and delivers `Send[]` via the API Gateway Management API.
- `src/local.ts` — a dev-only `ws` server running the same core against the
  in-memory store (see below).

## Local development

Real networked play, no AWS:

```
npm run dev:local --workspace=relay        # ws://localhost:8787
```

Then run the web client pointed at it:

```
VITE_WS_URL=ws://localhost:8787 npm run dev --workspace=web
```

Open two browsers, **Create** in one, copy the code, **Join** in the other.

## Scripts

- `npm run test --workspace=relay` — core + helper unit tests (Vitest).
- `npm run build --workspace=relay` — esbuild bundle to `dist/index.js`
  (`@aws-sdk/*` is external — provided by the Node 22 Lambda runtime).
- `npm run dev:local --workspace=relay` — the local `ws` relay.

## Deployment

CI (`.github/workflows/deploy-relay.yml`) builds and updates the Lambda created
by Terraform (`infrastructure/websocket.tf`); there is no deploy script here.
The Lambda reads `ROOMS_TABLE` (DynamoDB table name) from its environment.
