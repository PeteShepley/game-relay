import { describe, expect, test } from 'vitest'
import { generateCode, generateToken, seedFrom } from './rooms'

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

describe('seedFrom', () => {
  test('is a uint32 and deterministic in its two inputs', () => {
    const seed = seedFrom(123, 456)
    expect(Number.isInteger(seed)).toBe(true)
    expect(seed).toBeGreaterThanOrEqual(0)
    expect(seed).toBeLessThanOrEqual(0xffffffff)
    expect(seedFrom(123, 456)).toBe(seed)
  })

  test('depends on both contributions, and on their order', () => {
    expect(seedFrom(1, 2)).not.toBe(seedFrom(2, 1))
    expect(seedFrom(1, 2)).not.toBe(seedFrom(1, 3))
    expect(seedFrom(1, 2)).not.toBe(seedFrom(9, 2))
  })
})
