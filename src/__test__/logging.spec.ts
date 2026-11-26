import { format } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expandToBeatEvents, evaluateExpression, evaluateInitialization, parse } from '../index.js'

afterEach(() => vi.restoreAllMocks())

describe('print and warn', () => {
  it('passes zero or more evaluated arguments to console.log', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(evaluateExpression(parse('print()').body[0]!)).toMatchObject({
      value: { kind: 'container', values: [] },
      diagnostics: [],
    })
    evaluateExpression(parse('print(«step», 2, true, [3/2 4/3], C)').body[0]!)
    expect(log.mock.calls).toEqual([[], ['step', 2, true, '[3/2 4/3]', 'C']])
  })

  it.each([
    ['(1 2), [1 2], [1, 2]', ['(1 2)', '[1 2]', '[1, 2]']],
    ['(), [], (2,), [()], [(2,)]', ['()', '[]', '(2,)', '[()]', '[(2,)]']],
    ['([1 2]), [(1 2)], [(C=, D!) [3/2 4/3]]=', ['([1 2])', '[(1 2)]', '[(C=, D!) [3/2 4/3]]=']],
    ['asSequence([C, D]), asParallel([C D])', ['(C D)', '(C, D)']],
    ['(«a b», «c\\»d», niente)', ['(«a b», «c\\»d», niente)']],
  ])('prints the collection structure in %s', (args, expected) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = evaluateExpression(parse(`print(${args})`).body[0]!)
    expect(result.diagnostics).toEqual([])
    expect(log.mock.calls).toEqual([expected])
  })

  it('prints the structure and degrees of a stored collection', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = expandToBeatEvents(parse('let notes <- [1 2] $ print(notes)'))
    expect(result.diagnostics).toEqual([])
    expect(log.mock.calls).toEqual([['[1d 2d]']])
  })

  it('prints strings inside collections without interpolating the next argument', () => {
    const output: string[] = []
    vi.spyOn(console, 'log').mockImplementation((...args) => output.push(format(...args)))
    const result = evaluateExpression(parse('print([«literal %s» 2], 3)').body[0]!)
    expect(result.diagnostics).toEqual([])
    expect(output).toEqual(['[«literal %s» 2] 3'])
  })

  it('returns a warning through the score diagnostic array without adding time', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const source = 'C warn(«check this») D'
    const result = expandToBeatEvents(parse(source, { grammarSource: 'test.xp' }))
    expect(result.diagnostics).toMatchObject([
      {
        code: 'XP_WARN',
        severity: 'warning',
        message: 'check this',
        locations: [{ source: 'test.xp', start: { offset: 2 }, end: { offset: 20 } }],
      },
    ])
    if (!('score' in result)) throw new Error('Expected a score.')
    expect(result.score.duration.toFraction()).toBe('2')
    expect(result.score.events.map((event) => event.label)).toEqual(['C', 'D'])
    expect(log).not.toHaveBeenCalled()
  })

  it('keeps a warning alongside a later error', () => {
    const result = expandToBeatEvents(parse('warn(«first») $ missing()'))
    expect(result.diagnostics).toMatchObject([
      { code: 'XP_WARN', severity: 'warning', message: 'first' },
      { code: 'XP_UNDEFINED_NAME', severity: 'error' },
    ])
  })

  it('runs standalone calls in functions and preserves warnings through try', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const result = expandToBeatEvents(
      parse(`
      fn phrase() {
        print(«called»)
        warn(«notice»)
        ret C
      }
      try { phrase() } catch { D }
    `),
    )
    expect(result.diagnostics).toMatchObject([{ code: 'XP_WARN', message: 'notice' }])
    if (!('score' in result)) throw new Error('Expected a score.')
    expect(result.score.events.map((event) => event.label)).toEqual(['C'])
    expect(log.mock.calls).toEqual([['called']])
  })

  it('logs once at a settled attack in a continued slot with timed context changes', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { initialization } = evaluateInitialization(parse('. {19edo}'), { allowDuration: true })
    expect(initialization).toBeDefined()
    const result = expandToBeatEvents(
      parse('[print(«slot») C (print(«note») @or D) warn(«notice»)]= '),
      { initialization },
    )
    expect(result.diagnostics).toMatchObject([{ code: 'XP_WARN', message: 'notice' }])
    expect(result).toHaveProperty('score')
    expect(log.mock.calls).toEqual([['slot'], ['note']])
  })

  it.each(['tuning()', 'tuning() * 1/1', '4/3 tuning() 2/1'])(
    'reports output once from a scale defined with %s',
    (scale) => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const result = expandToBeatEvents(
        parse(`fn tuning() { print(«scale») warn(«check tuning») ret 3/2 } {scale <- ${scale}} 1`),
      )
      expect(result).toHaveProperty('score')
      expect(log.mock.calls).toEqual([['scale']])
      expect(result.diagnostics).toMatchObject([
        { code: 'XP_WARN', severity: 'warning', message: 'check tuning' },
      ])
    },
  )

  it('reapplies a scale to timed tuning changes while reporting its output once', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { initialization } = evaluateInitialization(parse('. {19edo}'), { allowDuration: true })
    const result = expandToBeatEvents(
      parse('fn tuning() { print(«scale») warn(«check tuning») ret ~3/2 } {scale <- tuning()} 1 1'),
      { initialization },
    )
    if (!('score' in result)) throw new Error('Expected a score.')
    const notes = result.score.events.filter((event) => event.kind === 'note')
    expect(notes.map(({ pitch }) => pitch.value.valueOf())).toEqual([
      expect.closeTo(1200 * Math.log2(3 / 2)),
      expect.closeTo((11 * 1200) / 19),
    ])
    expect(log.mock.calls).toEqual([['scale']])
    expect(result.diagnostics).toMatchObject([{ code: 'XP_WARN', message: 'check tuning' }])
  })

  it.each(['warn()', 'warn(1/1)', 'warn(«a», «b»)'])(
    'requires a single string argument in %s',
    (source) => {
      expect(evaluateExpression(parse(source).body[0]!).diagnostics).toMatchObject([
        { code: 'XP_TYPE_MISMATCH', severity: 'error' },
      ])
    },
  )
})
