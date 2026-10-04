# game-relay

The shared room **sequencer** for every multiplayer game on
`game.peteshepley.com`. It's an AWS API Gateway **WebSocket** API backed by a
Lambda, served at `wss://ws.peteshepley.com/relay`. The staging copy is at
`wss://ws.stage.peteshepley.com/relay`.

It deliberately knows nothing about any game's rules and never runs a game
engine. Each game's clients compute state as a pure function of
(seed, ordered action log), so the relay only has to own three things:

1. **Rooms.** Players create and join rooms by short code; each room holds
   2–8 seats. Each seat has its own reconnection token. A room belongs to one
   game, so a code from another game is refused. A room is abandoned once no
   seat is connected.
2. **Action order.** Every submitted action gets a per-room, monotonically
   increasing sequence number and is fanned out to every seat. Illegal actions
   are stamped and fanned out too; every client rejects them identically as
   deterministic no-ops.
3. **Bootstrap.** `start` sends a fresh contract. `resync` sends the contract
   plus the full log, so a reconnecting client can rebuild from scratch.

## Protocol

`src/protocol.ts` is the canonical wire protocol. Games import it rather than
re-declaring it, pinned to a release tag:

```jsonc
// a game's package.json
"dependencies": {
  "@peteshepley/game-relay": "github:PeteShepley/game-relay#v0.<run>"
}
```

```ts
import type { WireMessage, Contract } from '@peteshepley/game-relay/protocol'
```

The package exports only the protocol, and everything else is a
devDependency, so installing it pulls in nothing else.

### Room lifecycle

| Client sends | Relay replies |
|---|---|
| `create {game, name, rnd, minSeats, maxSeats}` | `created {code, token, seat:'a'}` + `roster` |
| `join {code, game, name, rnd}` | `joined {code, token, seat}` to the joiner, `roster` to all. When the last seat fills: `start` to all |
| `begin` (creator only, ≥ `minSeats` seated) | `start` to all |
| `addBot {name, rnd}` (creator only, lobby) | `roster` to all, with the new seat marked `bot: true` |
| `removeBot {seat}` (creator only, lobby, a bot seat) | `roster` to all |
| `reconnect {code, token}` | `created`/`joined` (lobby) or `start`/`resync` (in game), plus `roster` to all |
| `submit {action}` | `action {seq, action}` to all |
| `resyncRequest` | `start` (empty log) or `resync` |
| `ping` | `pong`. Clients should ping every ~5 minutes, because API Gateway drops a socket after ~10 idle minutes. |

- **Seats** are lettered in join order (`a`, `b`, `c`, …). The creator is `a`
  and is always the dealer. A two-seat game sees exactly the `'a' | 'b'` it
  always has. A seat freed by `removeBot` is the next one handed out.
- **Computer players** (`bot: true` in the roster and the contract) are
  seats the creator added. They count toward `minSeats` but never connect, so
  they don't start a full room by themselves (the creator sends `begin`) and
  don't keep an abandoned room alive. The relay doesn't run them: a connected
  human's client submits their actions, like any other action.
- **Seed:** every seat contributes a random `rnd`. `seedFrom` folds them in
  seat order, so no single player can grind for a favourable deal. For two
  seats this produces the same seed as the original gin-rummy relay.
- **Errors:** `badCode`, `wrongGame`, `alreadyStarted`, `roomFull`,
  `badToken`, `badRequest`, `notCreator`, `notEnoughPlayers`.

## Layout

- `src/relay.ts` is the core: `handleConnect` / `handleDisconnect` /
  `handleMessage(store, connectionId, message) -> Send[]`. It has no AWS imports.
- `src/store.ts` defines the `RoomStore` seam, with `InMemoryRoomStore` (tests
  and local dev) and `DynamoRoomStore` (production, one table). Room writes are
  guarded by a `version` attribute, so racing joins can't claim the same seat.
- `src/rooms.ts` holds the pure helpers: room codes, tokens, the contributed
  seed, and seat ids.
- `src/handler.ts` is the Lambda entry. It routes `$connect` / `$disconnect` /
  `$default`, delivers via the API Gateway Management API, and reads
  `ROOMS_TABLE` from its environment.
- `src/local.ts` is a dev-only `ws` server that runs the same core against the
  in-memory store.

## Development

```sh
npm install
npm test               # Vitest
npm run typecheck
npm run dev:local      # ws://localhost:8787, real networked play with no AWS
```

To play locally, point a game's dev server at the local relay with
`VITE_WS_URL=ws://localhost:8787`.

## Deployment

This repo holds no infrastructure. Every push to `main` runs
`.github/workflows/release.yml`, which runs the tests, bundles
`function.zip`, and publishes a GitHub Release tagged `v0.<run>`.

The Lambda, rooms table, and WebSocket API live in the `operations` repo
(stack `320-ws-game-relay`). Deploy a release from there:

```sh
scripts/deploy ws relay stage v0.<run>
scripts/deploy ws relay prod  v0.<run>
```
