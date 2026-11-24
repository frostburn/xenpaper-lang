import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it } from 'vitest'
import { renderPianoRoll } from '../../scripts/piano-roll.mjs'
import { expandToBeatEvents, parse } from '../index.js'

function pianoRoll(source: string) {
  const result = expandToBeatEvents(parse(source))
  if (!('score' in result)) throw new Error(JSON.stringify(result.diagnostics))
  const rows = new Map<string, string>()
  for (const line of renderPianoRoll(result.score, { color: false }).split('\n')) {
    const match = /^\s*(\S+)\s+│(.*)│/.exec(line)
    if (match) rows.set(match[1]!, match[2]!)
  }
  return rows
}

describe('development piano roll', () => {
  it('colors notes by default and preserves layout when color is disabled', () => {
    const result = expandToBeatEvents(parse('@gliss C G'))
    if (!('score' in result)) throw new Error(JSON.stringify(result.diagnostics))
    const colored = renderPianoRoll(result.score)
    const plain = renderPianoRoll(result.score, { color: false })
    expect(colored).toContain('\u001B[96m●\u001B[39m')
    expect(stripVTControlCharacters(plain)).toBe(plain)
    expect(stripVTControlCharacters(colored)).toBe(plain)
  })

  it('keeps fractional attacks in time order and puts lower pitches on the left', () => {
    const rows = pianoRoll('{31edo} [G E C]')
    const g = rows.get('0')!.indexOf('●')
    const e = rows.get('1/3')!.indexOf('●')
    const c = rows.get('2/3')!.indexOf('●')
    expect(c).toBeGreaterThanOrEqual(0)
    expect(c).toBeLessThan(e)
    expect(e).toBeLessThan(g)
    expect([...rows.keys()].filter((beat) => ['0', '1/3', '2/3'].includes(beat))).toEqual([
      '0',
      '1/3',
      '2/3',
    ])
  })

  it('distinguishes overlaps, held notes, and rests', () => {
    const rows = pianoRoll('(C, C) . E')
    expect(rows.get('0')).toContain('◆')
    expect(rows.get('1/4')).toContain('◆')
    expect(rows.get('1')).not.toMatch(/[◆●│]/)
    expect(rows.get('2')).toContain('●')
    expect(rows.get('9/4')).toContain('│')
  })

  it('plots a glide toward its destination and stops at the note end', () => {
    const rows = pianoRoll('@gliss C G')
    const start = rows.get('0')!.indexOf('●')
    const glide = rows.get('1/2')!.indexOf('╲')
    const target = rows.get('1')!.indexOf('│')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(start).toBeLessThan(glide)
    expect(glide).toBeLessThan(target)
    expect(rows.get('2')).not.toMatch(/[●│╱╲]/)
  })
})
