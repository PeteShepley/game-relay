import { randomBytes, randomInt } from 'node:crypto'

// A no-look-alike alphabet: no 0/O, 1/I/L. Six characters give ~10^9 codes,
// which are only guessable while a room has an open second seat, so an
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

// The shuffle seed both players contribute to: each side commits a random
// uint32 without seeing the other's, and the engine PRNG seed is a mix of
// both. Neither side alone can grind for a favourable deal. The output is a
// uint32 because the engine's mulberry32 threads a uint32 state.
//
// The creator's value is mixed first, then the joiner's is folded in with an
// add (not a xor) after that nonlinear round — otherwise (a,b) and (b,a)
// would collapse to the same seed, and neither round could cancel the other.
export function seedFrom(rndCreator: number, rndJoiner: number): number {
  const mixed = mix32((rndCreator >>> 0) ^ 0x9e3779b9)
  return mix32((mixed + (rndJoiner >>> 0)) >>> 0)
}

function mix32(x: number): number {
  let h = x >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}
