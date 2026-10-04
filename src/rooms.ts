import { randomBytes, randomInt } from 'node:crypto'

// A no-look-alike alphabet: no 0/O, 1/I/L. Six characters give ~10^9 codes,
// which are only guessable while a room still has an open seat, so an
// enumerating stranger has a vanishing window and reconnection is gated by a
// token rather than the code (see relay.ts).
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_LENGTH = 6

export function generateCode(): string {
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  }
  return out
}

// A per-seat secret that outlives socket connections. A reconnecting player
// proves they own a seat by presenting this, so knowing the room code is
// never enough to steal a seat mid-game.
export function generateToken(): string {
  return randomBytes(24).toString('base64url')
}

// The shuffle seed every player contributes to: each seat commits a random
// uint32 without seeing the others', and the engine PRNG seed is a mix of
// all of them. No single player can grind for a favourable deal. The output
// is a uint32 because the engines' mulberry32 threads a uint32 state.
//
// Contributions are folded in seat order, each with an add (not a xor) after
// a nonlinear round — so the order matters ((a,b) and (b,a) give different
// seeds) and no contribution can cancel another. For two seats this is
// exactly the seed the gin-rummy-only relay produced.
export function seedFrom(rnds: readonly number[]): number {
  if (rnds.length === 0) throw new Error('seedFrom needs at least one contribution')
  let h = mix32((rnds[0] >>> 0) ^ 0x9e3779b9)
  for (const rnd of rnds.slice(1)) h = mix32((h + (rnd >>> 0)) >>> 0)
  return h
}

function mix32(x: number): number {
  let h = x >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

// The most players any one room can hold (seat ids run 'a'..'h').
export const MAX_SEATS = 8

// Seat ids by position: 0 -> 'a', 1 -> 'b', ...
export function seatIdAt(index: number): string {
  return String.fromCharCode(97 + index)
}

// The first seat letter not in use. Seats letter in join order, but a
// computer player taken out of the lobby leaves a gap, and the next seat
// fills it rather than colliding with a later letter.
export function nextSeatId(taken: readonly string[]): string {
  for (let index = 0; ; index++) {
    const id = seatIdAt(index)
    if (!taken.includes(id)) return id
  }
}
