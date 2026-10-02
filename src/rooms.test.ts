import { describe, expect, test } from 'vitest'
import { generateCode, generateToken, seatIdAt, seedFrom } from './rooms'

describe('generateCode', () => {
  test('is six characters from the no-look-alike alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCode()
      expect(code).toHaveLength(6)
      expect(code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/)
      // The confusable glyphs are excluded on purpose.
      expect(code).not.toMatch(/[01ILO]/)
    }
  })
})

describe('generateToken', () => {
  test('is non-empty and practically unique', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 1000; i++) {
      const token = generateToken()
      expect(token.length).toBeGreaterThan(20)
      expect(seen.has(token)).toBe(false)
      seen.add(token)
    }
  })
})

// The seed the gin-rummy-only relay produced for (creator, joiner), kept here
// verbatim so the generalised fold can be pinned against it.
function legacySeed(rndCreator: number, rndJoiner: number): number {
  const mix32 = (x: number) => {
    let h = x >>> 0
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
    return (h ^ (h >>> 16)) >>> 0
  }
  return mix32((mix32((rndCreator >>> 0) ^ 0x9e3779b9) + (rndJoiner >>> 0)) >>> 0)
}

describe('seedFrom', () => {
  test('is a uint32 and deterministic in its inputs', () => {
    const seed = seedFrom([123, 456, 789])
    expect(Number.isInteger(seed)).toBe(true)
    expect(seed).toBeGreaterThanOrEqual(0)
    expect(seed).toBeLessThanOrEqual(0xffffffff)
    expect(seedFrom([123, 456, 789])).toBe(seed)
  })

  test('depends on every contribution, and on their order', () => {
    expect(seedFrom([1, 2])).not.toBe(seedFrom([2, 1]))
    expect(seedFrom([1, 2])).not.toBe(seedFrom([1, 3]))
    expect(seedFrom([1, 2])).not.toBe(seedFrom([9, 2]))
    expect(seedFrom([1, 2, 3])).not.toBe(seedFrom([1, 3, 2]))
    expect(seedFrom([1, 2, 3])).not.toBe(seedFrom([1, 2]))
  })

  test('matches the two-seat seed the gin-rummy relay produced', () => {
    for (const [a, b] of [[111, 222], [0, 0], [0xffffffff, 1], [123456789, 987654321]]) {
      expect(seedFrom([a, b])).toBe(legacySeed(a, b))
    }
  })

  test('needs at least one contribution', () => {
    expect(() => seedFrom([])).toThrow()
  })
})

describe('seatIdAt', () => {
  test('letters seats in order', () => {
    expect([0, 1, 2, 7].map(seatIdAt)).toEqual(['a', 'b', 'c', 'h'])
  })
})
