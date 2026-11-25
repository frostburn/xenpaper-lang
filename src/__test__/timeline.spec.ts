import { describe, expect, it } from 'vitest'
import { Fraction } from 'xen-dev-utils/fraction'
import {
  evaluateInitialization,
  evaluateTimeline,
  expandToBeatEvents,
  gridMeasureBoundaries,
  parse,
} from '../index.js'
import type { ScoreInitialization } from '../index.js'

function initialize(source: string, parent?: ScoreInitialization) {
  const result = evaluateInitialization(parse(source), {
    initialization: parent,
    allowDuration: !parent,
    allowTempoDirective: !parent,
    timeSignature: { numerator: 4, denominator: 4 },
  })
  expect(result.diagnostics).toEqual([])
  expect(result.initialization).toBeDefined()
  return result.initialization!
}

function score(source: string, initialization: ScoreInitialization, offset = new Fraction(0)) {
  const result = expandToBeatEvents(parse(source), { initialization, beatOffset: offset })
  expect(result.diagnostics).toEqual([])
  if (!('score' in result)) throw new Error('Expected a score')
  return result.score
}

function notes(source: string, initialization: ScoreInitialization, offset?: Fraction) {
  return score(source, initialization, offset).events.filter((event) => event.kind === 'note')
}

describe('global grid context', () => {
  it('applies groove changes from layered timelines at their absolute beats', () => {
    const parent = initialize('. @groove([C= C]) ...')
    const layer = evaluateInitialization(parse('@groove([C C=]) ....'), {
      initialization: parent,
      allowDuration: true,
    })
    expect(layer.diagnostics).toEqual([])
    expect(
      notes('[C D] [E F]', layer.initialization!).map(({ start }) => start.toFraction()),
    ).toEqual(['0', '1/3', '1', '5/3'])
  })

  it('keeps the global groove on the absolute grid around a function-local groove', () => {
    const initialization = initialize('@groove([C= C]) ..')
    const offset = new Fraction(1, 2)
    const source = 'fn phrase() { ret @groove([C= C]) [E F] } [C D] phrase() [G A]'

    expect(
      notes(source, initialization, offset).map(({ start, duration }) => [
        start.toFraction(),
        duration.toFraction(),
      ]),
    ).toEqual([
      ['1/6', '1/3'],
      ['1/2', '2/3'],
      ['1', '2/3'],
      ['5/3', '1/3'],
      ['13/6', '1/3'],
      ['5/2', '2/3'],
    ])
  })

  it.each([
    ['if(true) { let chosen <- true $ @2 . }'],
    ['for(chosen in [C D]) { if(chosen @eq 1) { @2 . } }'],
    ['for(chosen of [true]) { @2 . }'],
    ['while(chosen @eq false) { let chosen <- true $ @2 . }'],
  ])('restores outer bindings in the timeline after %s', (block) => {
    const initialization = initialize(`let chosen <- false ${block} .`)
    const phrase = 'if(chosen) { C } else { D }'
    expect(notes(phrase, initialization, new Fraction(1, 4))[0]?.label).toBe('C')
    const [after] = notes(phrase, initialization, new Fraction(1, 2))
    expect(after?.label).toBe('D')
    expect(after?.duration.toFraction()).toBe('1/2')
  })

  it('keeps the old binding in earlier clips and applies loop reassignment at its beat', () => {
    const initialization = initialize(`
let chosen <- false
.
for (value of [true]) { chosen <- value $ . }
.
`)
    const phrase = 'if (chosen) { C } else { D }'
    expect(notes(phrase, initialization, new Fraction(1, 2))[0]?.label).toBe('D')
    expect(notes(phrase, initialization, new Fraction(1))[0]?.label).toBe('C')
    expect(notes(phrase, initialization, new Fraction(2))[0]?.label).toBe('C')
  })

  it('applies subdivision changes while advancing the grid, including score length', () => {
    const initialization = initialize('. @2')
    const result = score('C D E F', initialization)
    expect(result.duration.toFraction()).toBe('5/2')
    expect(
      notes('C D E F', initialization).map(({ start, duration }) => [
        start.toFraction(),
        duration.toFraction(),
      ]),
    ).toEqual([
      ['0', '1'],
      ['1', '1/2'],
      ['3/2', '1/2'],
      ['2', '1/2'],
    ])
  })

  it('evaluates the actual expression when a reassigned variable changes its score shape', () => {
    const initialization = initialize('let phrase <- C $ . $ phrase <- (D E)')
    const result = notes('phrase phrase', initialization)
    expect(result.map(({ start }) => start.toFraction())).toEqual(['0', '1', '2'])
    expect(result.map(({ pitch }) => pitch.value.valueOf())).toEqual(
      notes('C D E', initialization).map(({ pitch }) => pitch.value.valueOf()),
    )
  })

  it('rejects redeclaring a function at another beat in one timeline', () => {
    const source = 'fn phrase() { ret C } . fn phrase() { ret E }'
    const result = evaluateInitialization(parse(source), { allowDuration: true })
    expect(result.initialization).toBeUndefined()
    expect(result.diagnostics).toMatchObject([
      {
        code: 'XP_DUPLICATE_FUNCTION',
        locations: [
          { start: { offset: source.lastIndexOf('phrase') } },
          { start: { offset: source.indexOf('phrase') } },
        ],
      },
    ])
  })

  it('initializes a child from the complete set of declarations at beat zero', () => {
    const global = initialize('let division <- 2/1 fn phrase() { ret C D } . {5edo}')
    const lane = initialize('@subdivision(division) fn local() { ret phrase() }', global)
    expect(notes('local()', lane).map(({ start }) => start.toFraction())).toEqual(['0', '1/2'])
  })

  it('keeps the initial state before the first switch and the final state after the last', () => {
    const initialization = initialize('. {5edo}')
    const baseline = notes('D', initialize(''))[0]!.pitch.value.valueOf()
    const changed = notes('D', initialize('{5edo}'))[0]!.pitch.value.valueOf()
    expect(notes('D', initialization)[0]!.pitch.value.valueOf()).toBe(baseline)
    expect(notes('D', initialization, new Fraction(100))[0]!.pitch.value.valueOf()).toBe(changed)
  })

  it('uses fractional absolute positions without rounding to nearby grid points', () => {
    const initialization = initialize('@3 . {5edo}')
    const before = notes('D', initialization, new Fraction(1, 3).sub(new Fraction(1, 1000000)))[0]!
    const after = notes('D', initialization, new Fraction(1, 3))[0]!
    expect(before.pitch.value.equals(after.pitch.value)).toBe(false)
  })

  it('resolves meter changes and bar rests without a DAW-supplied meter timeline', () => {
    const initialization = initialize('; @time(3/4)')
    expect(score('C ; | D ; |', initialization).duration.toFraction()).toBe('7')
    expect(notes('C ; | D ; |', initialization).map(({ start }) => start.toFraction())).toEqual([
      '0',
      '4',
    ])
  })

  it('restores context after an explicit global scope', () => {
    const initialization = initialize('({5edo} .) .')
    const result = notes('D D', initialization)
    expect(result[0]!.pitch.value.equals(result[1]!.pitch.value)).toBe(false)
    expect(result[1]!.pitch.value.equals(notes('D', initialize(''))[0]!.pitch.value)).toBe(true)
  })

  it('preserves local context changes across global switches and isolates groups', () => {
    const initialization = initialize('{5edo} . {12edo}')
    const result = notes('({root <- D} 0 0) 0', initialization)
    const expected = notes('{5edo} ({root <- D} 0) {12edo} ({root <- D} 0) 0', initialize(''))
    expect(result.map(({ pitch }) => pitch.value.valueOf())).toEqual(
      expected.map(({ pitch }) => pitch.value.valueOf()),
    )
  })

  it('applies context at the normalized positions inside a slot', () => {
    const initialization = initialize('[. {5edo} .]')
    const result = notes('[D D]', initialization)
    expect(result.map(({ start }) => start.toFraction())).toEqual(['0', '1/2'])
    expect(result[0]!.pitch.value.equals(result[1]!.pitch.value)).toBe(false)
  })

  it('applies context at the stretched positions of a continued normalized slot', () => {
    const initialization = initialize('. {5edo}')
    const result = notes('[D D]=', initialization)
    expect(result.map(({ start }) => start.toFraction())).toEqual(['0', '1'])
    expect(result[0]!.pitch.value.equals(result[1]!.pitch.value)).toBe(false)
  })

  it('stretches leading rests and reads the global context in a normalized parallel slot', () => {
    const result = notes('[. 1d, . 2d]=', initialize('. {24edo}'))
    expect(result.map(({ start }) => start.toFraction())).toEqual(['1', '1'])
    expect(result.map(({ pitch }) => pitch.value.valueOf())).toEqual([50, 100])
  })

  it.each([
    '(. 1d=, D)',
    '(D, . 1d =)',
    'let phrase <- (. 1d=, D) $ phrase',
    'fn phrase() { ret (. 1d=, D) } $ phrase()',
  ])(
    'uses the global context at the authored attack with a branch-local continuation in %s',
    (source) => {
      const initialization = initialize('.. {24edo}')
      const result = notes(source, initialization, new Fraction(1))
      const reference = notes('1d', initialization, new Fraction(2))[0]!
      expect(result[1]?.start.toFraction()).toBe('1')
      expect(result[1]?.pitch.value.equals(reference.pitch.value)).toBe(true)
      expect(reference.pitch.value.valueOf()).toBe(50)
    },
  )

  it('rejects an outer continuation on uneven attacks with a global timeline', () => {
    const initialization = initialize('.. {24edo}')
    const result = expandToBeatEvents(parse('(. 1d, D) ='), { initialization })
    expect(result.diagnostics).toMatchObject([{ code: 'XP_UNEVEN_PARALLEL_CONTINUATION' }])
    expect('score' in result).toBe(false)
  })

  it('reads a reassigned global variable at the attack with a branch-local continuation', () => {
    const initialization = initialize('let phrase <- C $ . $ phrase <- E')
    const result = notes('(. phrase=, D)', initialization)
    expect(result.map(({ start }) => start.toFraction())).toEqual(['0', '1'])
    expect(result.map(({ pitch }) => pitch.value.valueOf())).toEqual(
      notes('D E', initialization).map(({ pitch }) => pitch.value.valueOf()),
    )
  })

  it('looks up the timeline separately for each expanded repeat occurrence', () => {
    const initialization = initialize('@time(3/4) .... {24edo}')
    const result = notes('|: (. 1d=, D) :|', initialization)
    expect(
      result
        .filter(({ label }) => label === '1d')
        .map(({ start, pitch }) => [start.toFraction(), pitch.value.valueOf()]),
    ).toEqual([
      ['1', 100],
      ['4', 50],
    ])
  })

  it('keeps ordinary group attacks on their original global context positions', () => {
    const initialization = initialize('. [. {5edo} .]')
    const result = notes('(D D D)==', initialization)
    const expected = notes('D D D==', initialization)
    expect(
      result.map(({ start, duration, pitch }) => [
        start.toFraction(),
        duration.toFraction(),
        pitch.value.valueOf(),
      ]),
    ).toEqual(
      expected.map(({ start, duration, pitch }) => [
        start.toFraction(),
        duration.toFraction(),
        pitch.value.valueOf(),
      ]),
    )
  })

  it.each([
    '[phrase phrase]',
    'fn emit(part) { ret part } $ [emit(phrase) emit(phrase)]',
    '[[phrase] [phrase]]',
  ])('chooses phrase structure at the outer slot entry in %s', (source) => {
    const global = initialize('let phrase <- C $ [. $ phrase <- (D E) $ .]')
    const result = score(source, global)
    const events = result.events.filter((event) => event.kind === 'note')
    expect(result.duration.toFraction()).toBe('1')
    expect(
      events.map(({ start, duration }) => [start.toFraction(), duration.toFraction()]),
    ).toEqual([
      ['0', '1/2'],
      ['1/2', '1/2'],
    ])
    expect(events.map(({ pitch }) => pitch.value.valueOf())).toEqual([0, 0])
  })

  it('takes a new phrase binding at the next slot and repeat occurrence', () => {
    const global = initialize('@time(1/4) let phrase <- C $ . $ phrase <- (D E)')
    const result = notes('|: [phrase phrase] :|', global)
    expect(result.map(({ start }) => start.toFraction())).toEqual([
      '0',
      '1/2',
      '1',
      '5/4',
      '3/2',
      '7/4',
    ])
    expect(result.map(({ pitch }) => pitch.value.valueOf())).toEqual(
      notes('C C D E D E', initialize('')).map(({ pitch }) => pitch.value.valueOf()),
    )
  })

  it('keeps the selected phrase when the timed binding becomes a single note', () => {
    const global = initialize('let phrase <- (C D) $ [. $ phrase <- E $ .]')
    const result = notes('[phrase phrase]', global)
    expect(result.map(({ start }) => start.toFraction())).toEqual(['0', '1/4', '1/2', '3/4'])
    expect(result.map(({ pitch }) => pitch.value.valueOf())).toEqual(
      notes('C D C D', initialize('')).map(({ pitch }) => pitch.value.valueOf()),
    )
  })

  it('reads single-note bindings at their final attack beats after a continuation', () => {
    const global = initialize('let tone <- 1d $ . $ tone <- 2d $ {24edo} @f')
    const result = notes('[tone tone]=', global)
    expect(result.map(({ start }) => start.toFraction())).toEqual(['0', '1'])
    expect(result.map(({ pitch }) => pitch.value.valueOf())).toEqual([100, 100])
    expect(result.map(({ dynamic }) => dynamic.toFraction())).toEqual(['1/2', '13/20'])
  })

  it('uses the slot entry to decide control flow that expands a phrase', () => {
    const global = initialize('let longer <- false $ [. $ longer <- true $ .]')
    const result = notes('[C $ if(longer) { D E } else { F }]', global)
    expect(result.map(({ label, start }) => [label, start.toFraction()])).toEqual([
      ['C', '0'],
      ['F', '1/2'],
    ])
  })

  it('applies local bindings and tuning to structural selection and attack reads', () => {
    const global = initialize('let phrase <- C $ [. $ phrase <- (D E) $ {24edo} .]')
    const result = notes('[let phrase <- (1d 2d) $ {12edo} phrase]', global)
    expect(result.map(({ start }) => start.toFraction())).toEqual(['0', '1/2'])
    expect(result.map(({ pitch }) => pitch.value.valueOf())).toEqual([100, 200])

    const local = notes('[let phrase <- D $ phrase $ phrase <- F $ phrase]', global)
    expect(local.map(({ pitch }) => pitch.value.valueOf())).toEqual(
      notes('D F', initialize('')).map(({ pitch }) => pitch.value.valueOf()),
    )
  })

  it('rejects sounding initialization notes in parallel branches', () => {
    expect(
      evaluateInitialization(parse('(C, D)'), { allowDuration: true }).diagnostics,
    ).toContainEqual(expect.objectContaining({ code: 'XP_INITIALIZATION', severity: 'error' }))
  })
})

describe('abstract tempo and meter', () => {
  it('anchors normalized meter changes and barlines to their scaled grid positions', () => {
    const global = initialize('[. @time(3/4) .]')
    expect(score(';', global, new Fraction(1, 2)).duration.toFraction()).toBe('3')
    const checked = expandToBeatEvents(parse('@time(4/4) [C C C C | D]'))
    expect(checked.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'XP_BARLINE_OFF_CYCLE' }),
    )
  })
  it('restores the enclosing tempo after an explicit scope', () => {
    const result = evaluateTimeline(parse('(@tempo(180bpm) .) .'), { tempo: 120 })
    expect(
      result.tempoChanges.map(({ beat, bpm }) => [beat.toFraction(), bpm.toFraction()]),
    ).toEqual([
      ['0', '180'],
      ['1', '120'],
    ])
  })
  it('expands tempo changes onto exact grid positions without stretching the abstract score', () => {
    const result = evaluateTimeline(parse('|: @3 . @tempo(123.5bpm) . @tempo(240bpm) . :|'))
    expect(result.diagnostics).toEqual([])
    expect(
      result.tempoChanges.map(({ beat, bpm }) => [beat.toFraction(), bpm.toFraction()]),
    ).toEqual([
      ['1/3', '247/2'],
      ['2/3', '240'],
      ['4/3', '247/2'],
      ['5/3', '240'],
    ])
    expect(result.initialization!.timelineShape!.duration.toFraction()).toBe('2')
  })

  it('enumerates measure boundaries on the exact grid', () => {
    const result = gridMeasureBoundaries(
      [{ beat: new Fraction(0), numerator: 1, denominator: 12 }],
      3,
    )
    expect(result.map((beat) => beat.toFraction())).toEqual([
      '0',
      '1/3',
      '2/3',
      '1',
      '4/3',
      '5/3',
      '2',
      '7/3',
      '8/3',
      '3',
    ])
  })
})
