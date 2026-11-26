import { describe, expect, it } from 'vitest'
import { Fraction } from 'xen-dev-utils/fraction'
import { parse } from '../parser.js'
import { expandToBeatEvents } from '../runtime/beat-events.js'
import { evaluateInitialization } from '../runtime/initialization.js'
import { expandRepeats } from '../runtime/repeat-expansion.js'

const score = (source: string) => {
  const result = expandToBeatEvents(parse(source))
  expect(result.diagnostics).toEqual([])
  if (!('score' in result)) throw new Error('Expected a beat-timed score.')
  return result.score
}

const audibleResult = (source: string, includeLabels = true) => {
  const result = score(source)
  return {
    duration: result.duration.toFraction(),
    events: result.events
      .filter((event) => event.kind !== 'marker')
      .map((event) => ({
        kind: event.kind,
        start: event.start.toFraction(),
        duration: event.duration.toFraction(),
        pitch: [event.pitch.kind, event.pitch.value.valueOf()],
        ...(includeLabels && 'label' in event ? { label: event.label } : {}),
        ...('dynamic' in event ? { dynamic: event.dynamic.toFraction() } : {}),
      })),
  }
}

describe('beat event expansion', () => {
  it('visits descending range indices in score loops', () => {
    const source = 'let melody <- (C D E F G) $ for(index of range(4, -1, -2)) { melody[index] }'
    expect(audibleResult(source, false)).toEqual(audibleResult('G E C', false))
  })

  it('plays a positive range as a sequence of ratios', () => {
    expect(audibleResult('range(2, 8, 2)', false)).toEqual(audibleResult('2/1 4/1 6/1', false))
  })

  it.each(['() (C,) D', 'let empty <- () $ let single <- (C,) $ empty single D'])(
    'plays empty and singleton parallels in %s',
    (source) => {
      expect(audibleResult(source, false)).toEqual(audibleResult('C D', false))
    },
  )

  it.each([
    '4::6 * 6::8',
    'let lower <- 4::6 $ 6::8 * lower',
    'let lower <- 4::6 $ lower * 6::8',
    'let lower <- 4::6 $ let higher <- 6::8 $ lower * higher',
    'fn higher() { ret 6::8 } $ 4::6 * higher()',
    'fn product() { ret 4::6 * 6::8 } $ product()',
    'let product <- 4::6 * 6::8 $ product',
    'let higher <- 6::8 $ (1/1, 5/4, 3/2) * higher',
  ])('plays the elementwise chord product in %s', (source) => {
    expect(audibleResult(source, false)).toEqual(audibleResult('(1/1, 35/24, 2/1)', false))
  })

  it.each([
    '4::5 * 6::8',
    'let lower <- 4::5 $ let higher <- 6::8 $ lower * higher',
    'fn higher() { ret 6::8 } $ 4::5 * higher()',
  ])('rejects mismatched chord lengths in %s', (source) => {
    const result = expandToBeatEvents(parse(source))
    expect(result.diagnostics).toMatchObject([
      { code: 'XP_TYPE_MISMATCH', message: 'Container operands must have the same length.' },
    ])
  })

  it.each([
    ['{12edo} ~(4::6 * 6::8)', '{12edo} (~1/1, ~35/24, ~2/1)'],
    ["'(4::6 * 6::8)", "'(1/1, 35/24, 2/1)"],
  ])('applies pitch operators to each product in %s', (source, expected) => {
    expect(audibleResult(source)).toEqual(audibleResult(expected))
  })

  it('plays all harmonic pairs when explicitly mapped and flattened', () => {
    const writtenOut = '(1/1 * 1/1, 1/1 * 7/6, 1/1 * 4/3), (5/4 * 1/1, 5/4 * 7/6, 5/4 * 4/3)'
    const source = 'let higher <- 6::8 $ asParallel(flat(arrayMap((note) => note * higher, 4::5)))'
    expect(audibleResult(source)).toEqual(audibleResult(writtenOut))
  })

  it.each([
    ['4::6 modc 6::8', 'let lower <- 4::6 $ let higher <- 6::8 $ lower modc higher'],
    ['4::6 rdc (2/1 * 6::8)', 'let lower <- 4::6 $ let higher <- 2/1 * 6::8 $ lower rdc higher'],
    ['4::6 + 6::8', 'let lower <- 4::6 $ let higher <- 6::8 $ lower + higher'],
  ])('uses elementwise arithmetic for %s', (written, bound) => {
    const result = audibleResult(written, false)
    expect(result.events).toHaveLength(3)
    expect(result).toEqual(audibleResult(bound, false))
  })

  it('pairs a written normalized slot with a bound slot', () => {
    const written = 'let factors <- [3/2 2/1] $ [1/1 5/4] * factors'
    const bound = 'let factors <- [3/2 2/1] $ let base <- [1/1 5/4] $ base * factors'
    const result = audibleResult(written)
    expect(result).toEqual(audibleResult(bound))
    expect(result.events).toHaveLength(2)
  })

  it.each([
    ['1/1 + (0/1 @and 1::10001)', '1/1'],
    ['1/1 + (3/2 @or 1::10001)', '5/2'],
    ['4::6 @or 1::10001', '4::6'],
    ['false @or (C . D=)', 'C . D='],
    ['(true @and [1/1 3/2]) * [1/1 4/3]', '[1/1 2/1]'],
    ['(1/1, 4/3) * (false @or (1/1, 3/2))', '(1/1, 2/1)'],
    [
      'fn choose(flag: boolean) { ret flag @and [C E] @or [D F] } $ choose(true) choose(false)',
      '[C E] [D F]',
    ],
  ])('plays the value selected by a logical operator in %s', (source, expected) => {
    expect(audibleResult(source, false)).toEqual(audibleResult(expected, false))
  })

  it.each([
    ['C al [D E]', 'C'],
    ['C al 1::10001', 'C'],
    ['4::6 al 1::10001', '4::6'],
    ['(C al 1::10001) + M2', 'C + M2'],
    ['(C al [D E]) + M2', 'C + M2'],
    ['let phrase <- C al 1::10001 $ phrase', 'C'],
    ['niente al [D E]', '[D E]'],
    ['let phrase <- niente al [D E] $ phrase', '[D E]'],
    ['niente al (C . D=)', 'C . D='],
  ])('plays only the selected operand in %s', (source, expected) => {
    expect(audibleResult(source, false)).toEqual(audibleResult(expected, false))
  })

  it.each(['niente al 1::10001', '1::10001 al C', 'true @and 1::10001', 'false @or 1::10001'])(
    'reports expansion limits for the evaluated operand in %s',
    (source) => {
      const result = expandToBeatEvents(parse(source))
      expect(result.diagnostics).toMatchObject([{ code: 'XP_EXPANSION_LIMIT' }])
    },
  )

  it('keeps branch rhythms when broadcasting over a harmonic chord', () => {
    const result = score('(C E, D=) + 4::6')
    const notes = result.events.filter((event) => event.kind === 'note')
    expect(result.duration.toFraction()).toBe('2')
    expect(notes.map(({ start, duration }) => [start.toFraction(), duration.toFraction()])).toEqual(
      [
        ['0', '1'],
        ['0', '2'],
        ['0', '1'],
        ['0', '2'],
        ['0', '1'],
        ['0', '2'],
        ['1', '1'],
        ['1', '1'],
        ['1', '1'],
      ],
    )
  })

  it('carries the same paths through transposition as through repeat expansion', () => {
    const program = parse('(C :| D :|) + M2 $ E')
    const paths = expandRepeats(parse(' C :| D :| E')).program!.body.map(
      (node) => node.expansionPath,
    )
    const result = expandToBeatEvents(program)
    if (!('score' in result)) throw new Error('Expected a beat-timed score.')
    expect(
      result.score.events
        .filter((event) => event.kind === 'note')
        .map((event) => event.expansionPath ?? []),
    ).toEqual(paths)
  })

  it('keeps caller and callee repeat paths when playing a deferred block', () => {
    const definition = 'fn play() { ret (if(true) { @p F :| }) }'
    const { initialization } = evaluateInitialization(
      parse(definition, { grammarSource: 'library' }),
    )
    const program = parse('|: play() :| G', { grammarSource: 'clip' })
    const result = expandToBeatEvents(program, { initialization })
    expect(result.diagnostics).toEqual([])
    if (!('score' in result)) throw new Error('Expected a beat-timed score.')
    const paths = [0, 1].flatMap((outer) =>
      [0, 1].map((inner) => [
        { source: 'clip', repeatOffset: 0, iteration: outer },
        { source: 'library', repeatOffset: definition.indexOf('@p'), iteration: inner },
      ]),
    )
    const events = result.score.events
    expect(
      events.filter((event) => event.kind === 'note').map((event) => event.expansionPath),
    ).toEqual([...paths, undefined])
    expect(
      events
        .filter((event) => event.kind === 'marker' && event.marker === 'dynamic')
        .map((event) => event.expansionPath),
    ).toEqual(paths)
  })

  it.each([
    ['let phrase <- C . D $ phrase phrase', 'C . D C . D'],
    ['let phrase <- C -> C $ phrase', 'C -> C'],
    ['let phrase <- C = = $ phrase', 'C=='],
    ['let phrase <- [C . D] $ phrase', '[C . D]'],
    ['let phrase <- C . D,E $ phrase', 'C . D,E'],
    ['let phrase <- C $ phrase <- D . E $ phrase', 'D . E'],
    ['let phrase <- |: C |¹ D :|² E || $ phrase phrase', 'C D C E C D C E'],
    ['let phrase <- (C D :|) $ phrase', 'C D C D'],
    ['let phrase <- (C :| D :| $ E :| F :|) $ phrase', 'C C D C C D E E F E E F'],
    ['let phrase <- @2 C . D $ phrase E', '(@2 C . D) E'],
    ['fn play(item) { ret item } $ play((C . D))', 'C . D'],
    ['fn build() { ret |: C D :| } $ let phrase <- build() $ phrase', 'C D C D'],
    ['fn play() { ret (C :| C :|) + M2 } $ play()', '(C C C C C C) + M2'],
    [
      'fn build(item) { let phrase <- item . C $ item <- E $ ret phrase } $ build(D)',
      'let note <- D $ note . C',
    ],
  ])('plays the stored score in %s', (source, expected) => {
    expect(audibleResult(source)).toEqual(audibleResult(expected))
  })

  it('plays a stored fragment at the current tuning and pulse', () => {
    const result = score('let phrase <- 1d . 2d $ {24edo} @2 phrase 1d')
    const notes = result.events.filter((event) => event.kind === 'note')
    expect(notes.map((note) => [note.start.toFraction(), note.pitch.value.valueOf()])).toEqual([
      ['0', 50],
      ['1', 100],
      ['3/2', 50],
    ])
    expect(result.duration.toFraction()).toBe('2')
  })

  it('expands stored repeats only when played and applies the expansion limit', () => {
    const binding = 'let phrase <- |:@x1000 C :| $ '
    const options = { expansionLimit: 100 }
    expect(expandToBeatEvents(parse(binding + 'D'), options).diagnostics).toEqual([])
    expect(expandToBeatEvents(parse(binding + 'phrase'), options).diagnostics).toMatchObject([
      { code: 'XP_EXPANSION_LIMIT' },
    ])
  })

  it('leaves later implicit repeats unexpanded when an earlier section breaks', () => {
    const program = parse('for(note of [C]) { note break :| |:@x999999 D :| :| } E')
    const result = expandToBeatEvents(program, { expansionLimit: 100 })
    expect(result.diagnostics).toEqual([])
    if (!('score' in result)) throw new Error('Expected a beat-timed score.')
    expect(result.score.events.filter((event) => event.kind === 'note')).toMatchObject([
      { pitch: { spelling: { raw: 'C' } } },
      { pitch: { spelling: { raw: 'E' } } },
    ])
  })

  it('plays a saved function body with a separate trailing return', () => {
    const program = parse('fn choose() { ret D } $ choose()')
    const declaration = program.body[0]
    if (declaration?.type !== 'FunctionDeclaration') throw new Error('Expected a function.')
    const [returned] = declaration.body.statements
    if (returned?.type !== 'ReturnStatement') throw new Error('Expected a return.')
    const expected = expandToBeatEvents(program)
    declaration.body = { ...declaration.body, statements: [], returnStatement: returned }
    expect(expandToBeatEvents(program)).toEqual(expected)
  })

  it.each([
    ['(let motif <- 1 $ motif)', '(let motif <- 1\nmotif)'],
    ['[let motif <- 1 $ motif]', '[let motif <- 1\nmotif]'],
    ['[let motif <- 1 2 $ motif 3 $]', '[let motif <- 1 2\nmotif 3]'],
    ['C $ D :|', 'C D D'],
    ['C :| $ D :|', 'C C D D'],
    ['(C $ D :|)', '(C D D)'],
    ['[C $ D :|]', '[C D D]'],
    ['C || $ D :|', 'C || D D'],
    ['|: C $ D :|', 'C D C D'],
  ])('evaluates the statement delimiter in %s', (actual, expected) => {
    expect(audibleResult(actual)).toEqual(audibleResult(expected))
  })

  it.each([
    'let chord <- C,E,G $ chord',
    'let chord <- C,E,G\nchord',
    'let chord <- C,\n E,\n G\nchord',
    'let chord <- C $ chord <- C,E,G $ chord',
    'fn phrase(chord) { chord <- C,E,G $ ret chord } $ phrase(C)',
  ])('plays ungrouped parallel binding values in %s', (source) => {
    const result = score(source)
    expect(result.duration.toFraction()).toBe('1')
    expect(result.events.map((event) => [event.kind, event.start.toFraction()])).toEqual([
      ['note', '0'],
      ['note', '0'],
      ['note', '0'],
    ])
    expect(
      result.events.map((event) => event.kind === 'note' && event.pitch.value.valueOf()),
    ).toEqual(
      score('C,E,G').events.map((event) => event.kind === 'note' && event.pitch.value.valueOf()),
    )
  })

  it('binds a sequence more tightly than a comma in a parallel binding value', () => {
    const result = score('let phrase <- C D,E $ phrase')
    expect(result.duration.toFraction()).toBe('2')
    expect(result.events.map((event) => event.start.toFraction())).toEqual(['0', '0', '1'])
  })

  it.each([
    'let foo <- 1 $ let bar <- 2 3 $ foo bar',
    'let foo <- 1\nlet bar <- 2 3\n\nfoo bar',
    'let foo <- 1\nlet bar <- (\n  2\n  3\n)\n\nfoo bar',
    'let foo <- 1 # comment\r\nlet bar <- 2 3\r\nfoo bar $',
    'fn phrase() { let bar <- 2 3 $ ret 1 bar $ } $ phrase()',
    'if(true) { let bar <- 2 3 $ 1 bar $ }',
    'let bar <- 0 $ bar <- 2 3 $ 1 bar',
    'let bar <- 0\nbar <- 2 3\n1 bar',
    'let bar <- 0\nbar <- (\n  2\n  3\n)\n1 bar',
    'fn phrase(bar) { bar <- 2 3 $ ret 1 bar } $ phrase(0)',
  ])('plays 1 2 3 with delimited declarations in %s', (source) => {
    const result = score(source)
    expect(result.duration.toFraction()).toBe('3')
    expect(
      result.events.map((event) =>
        event.kind === 'note'
          ? [event.start.toFraction(), event.duration.toFraction(), event.pitch.value.valueOf()]
          : event.kind,
      ),
    ).toEqual([
      ['0', '1', 100],
      ['1', '1', 200],
      ['2', '1', 300],
    ])
  })

  it.each(['cps((1 3 5 7), 2)', 'eulerGenus(45)'])(
    'supports sequential, slotted, and parallel playback of %s',
    (source) => {
      const plain = audibleResult(source)
      expect(plain.events.map(({ start, duration }) => [start, duration])).toEqual(
        Array.from({ length: 6 }, (_, index) => [String(index), '1']),
      )
      expect(plain.duration).toBe('6')

      const wrapped = audibleResult(`[${source}]`)
      expect(wrapped.events.map(({ start, duration }) => [start, duration])).toEqual(
        Array.from({ length: 6 }, (_, index) => [new Fraction(index, 6).toFraction(), '1/6']),
      )
      expect(wrapped.duration).toBe('1')
      const parallel = audibleResult(`asParallel(${source})`)
      expect(parallel.events.map(({ start, duration }) => [start, duration])).toEqual(
        Array.from({ length: 6 }, () => ['0', '1']),
      )
      expect(parallel.duration).toBe('1')
      expect(parallel.events.map(({ pitch }) => pitch)).toEqual(
        plain.events.map(({ pitch }) => pitch),
      )

      expect(wrapped.events.map(({ pitch }) => pitch)).toEqual(
        plain.events.map(({ pitch }) => pitch),
      )
    },
  )

  it.each([
    ['@time(4/4)1;|2', '@time(4/4)1...|2'],
    ['@time(5/4)1;|2', '@time(5/4)1....|2'],
    ['@time(2/4);;;', '@time(2/4).. .. ..'],
  ])('advances bar rests to the next measure boundary in %s', (actual, expected) => {
    expect(audibleResult(actual)).toEqual(audibleResult(expected))
  })

  it('warns and gives a bar rest no duration when no time signature prevails', () => {
    const result = expandToBeatEvents(parse('1;2'))

    expect(result.diagnostics).toMatchObject([
      {
        code: 'XP_BAR_REST_WITHOUT_TIME_SIGNATURE',
        severity: 'warning',
        locations: [{ start: { offset: 1 }, end: { offset: 2 } }],
      },
    ])
    expect('score' in result && result.score.duration.toFraction()).toBe('2')
  })

  it('recomputes parallel padding after resolving bar rests', () => {
    expect(score('@time(4/4)(1;, 1 2 3 4 5)').duration.toFraction()).toBe('5')
  })

  it('resolves an inherited bar rest from the absolute clip offset', () => {
    const result = expandToBeatEvents(parse(';'), {
      beatOffset: new Fraction(1),
      timeSignature: { numerator: 4, denominator: 4 },
    })

    expect(result.diagnostics).toEqual([])
    expect('score' in result && result.score.duration.toFraction()).toBe('3')
  })

  it('resolves bar rests and barlines against inherited meter changes', () => {
    const options = {
      beatOffset: new Fraction(0),
      timeSignature: { numerator: 4, denominator: 4 },
      timeSignatureChanges: [
        { beat: new Fraction(0), numerator: 4, denominator: 4 },
        { beat: new Fraction(4), numerator: 5, denominator: 4 },
      ],
    }
    const result = expandToBeatEvents(parse('1;|2;|'), options)

    expect(result.diagnostics).toEqual([])
    expect('score' in result && result.score.duration.toFraction()).toBe('9')
  })

  it('resets the barline cycle where an authored time signature begins', () => {
    const result = expandToBeatEvents(parse('.... @time(3/4) 1==|'), {
      timeSignature: { numerator: 4, denominator: 4 },
    })

    expect(result.diagnostics).toEqual([])
  })

  it('compares the sounding value of root-relative absolute pitches', () => {
    expect(audibleResult('C')).not.toEqual(audibleResult('{root <- D} C'))
  })

  it('scales every note when a normalized slot is continued', () => {
    const result = score('[0 2 7] [0 2 7]= [0 2 7]===')
    const notes = result.events.filter((event) => event.kind === 'note')

    expect(result.duration.valueOf()).toBe(7)
    expect(notes.map((note) => note.start.valueOf())).toEqual([
      0,
      1 / 3,
      2 / 3,
      1,
      5 / 3,
      7 / 3,
      3,
      13 / 3,
      17 / 3,
    ])
    expect(notes.map((note) => note.duration.valueOf())).toEqual([
      1 / 3,
      1 / 3,
      1 / 3,
      2 / 3,
      2 / 3,
      2 / 3,
      4 / 3,
      4 / 3,
      4 / 3,
    ])
    expect(notes.map((note) => note.start.add(note.duration).valueOf())).toEqual([
      1 / 3,
      2 / 3,
      1,
      5 / 3,
      7 / 3,
      3,
      13 / 3,
      17 / 3,
      7,
    ])
  })

  it.each([
    ['(0 5 7)!', ['0', '1', '2'], ['3', '2', '1'], '3'],
    ['[0 5 7]!', ['0', '1/3', '2/3'], ['1', '2/3', '1/3'], '1'],
    ['(0 5 7)!=', ['0', '1', '2'], ['4', '3', '2'], '4'],
    ['[0 5 7]!=', ['0', '1/3', '2/3'], ['2', '5/3', '4/3'], '2'],
    ['[0 5 7]=!=', ['0', '2/3', '4/3'], ['3', '7/3', '5/3'], '3'],
  ])('holds attacks independently for %s', (source, starts, durations, totalDuration) => {
    const result = score(source)
    const notes = result.events.filter((event) => event.kind === 'note')

    expect(notes.map((note) => note.start.toFraction())).toEqual(starts)
    expect(notes.map((note) => note.duration.toFraction())).toEqual(durations)
    expect(result.duration.toFraction()).toBe(totalDuration)
  })

  it.each([
    ['(1 2 3)==', ['0', '1', '2'], ['1', '1', '3'], '5'],
    ['(1 2 3) ==', ['0', '1', '2'], ['1', '1', '3'], '5'],
    ['((1 2) 3)==', ['0', '1', '2'], ['1', '1', '3'], '5'],
    ['(1 2 3)== 4', ['0', '1', '2', '5'], ['1', '1', '3', '1'], '6'],
    ['let foo <- C== $ foo foo', ['0', '3'], ['3', '3'], '6'],
    ['let foo <- C== $ @2 foo', ['0'], ['3/2'], '3/2'],
    ['let foo <- C $ foo <- C== $ foo', ['0'], ['3'], '3'],
    ['let phrase <- (1 2 3) $ phrase==', ['0', '1', '2'], ['1', '1', '3'], '5'],
    ['let phrase <- (1 2 3)== $ phrase', ['0', '1', '2'], ['1', '1', '3'], '5'],
    ['fn phrase() { ret (1 2 3) } phrase()==', ['0', '1', '2'], ['1', '1', '3'], '5'],
    ['[1 2 3]==', ['0', '1', '2'], ['1', '1', '1'], '3'],
    ['([1 2 3])==', ['0', '1', '2'], ['1', '1', '1'], '3'],
    ['let phrase <- [1 2 3] $ phrase==', ['0', '1', '2'], ['1', '1', '1'], '3'],
    ['let phrase <- [1 2 3]== $ phrase', ['0', '1', '2'], ['1', '1', '1'], '3'],
    ['(1, 2, 3)==', ['0', '0', '0'], ['3', '3', '3'], '3'],
    ['(C, D) = F', ['0', '0', '2'], ['2', '2', '1'], '3'],
    ['(C=, D=)=', ['0', '0'], ['3', '3'], '3'],
    ['let phrase <- (1, 2, 3)== $ phrase', ['0', '0', '0'], ['3', '3', '3'], '3'],
    ['(. C, . D) =', ['1', '1'], ['2', '2'], '3'],
    ['[. C, . D] =', ['1', '1'], ['1', '1'], '2'],
    ['[C, D E]= F', ['0', '0', '1', '2'], ['1', '1', '1', '1'], '3'],
    ['[. C . D] =', ['1/2', '3/2'], ['1/2', '1/2'], '2'],
    ['((. C) -> D) =', ['1', '2'], ['1', '2'], '4'],
    ['C==?? D', ['0', '1'], ['1', '1'], '2'],
    ['C!? D', ['0', '0'], ['0', '1'], '1'],
    ['C==?=? D', ['0', '2'], ['2', '1'], '3'],
    ['[C D]=? E', ['0', '1', '1'], ['1', '0', '1'], '2'],
    ['[0, 4 7]=!', ['0', '0', '1'], ['2', '2', '1'], '2'],
    ['[0, 4 7]==!', ['0', '0', '3/2'], ['3', '3', '3/2'], '3'],
    ['(C==, D E=) F', ['0', '0', '1', '3'], ['3', '1', '2', '1'], '4'],
    ['(C, D E)! F', ['0', '0', '1', '2'], ['2', '2', '1', '1'], '3'],
    ['(C, D E)!= F', ['0', '0', '1', '3'], ['3', '3', '2', '1'], '4'],
    ['(1 2 3)==!', ['0', '1', '2'], ['5', '4', '3'], '5'],
    ['(1 2 3)!=', ['0', '1', '2'], ['4', '3', '2'], '4'],
    ['(1 2 3)=!=', ['0', '1', '2'], ['5', '4', '3'], '5'],
    ['let phrase <- (1 2 3)=!= $ phrase', ['0', '1', '2'], ['5', '4', '3'], '5'],
  ])('retains continuation timing for %s', (source, starts, durations, totalDuration) => {
    const result = score(source)
    const notes = result.events.filter((event) => event.kind === 'note')

    expect(notes.map((note) => note.start.toFraction())).toEqual(starts)
    expect(notes.map((note) => note.duration.toFraction())).toEqual(durations)
    expect(result.duration.toFraction()).toBe(totalDuration)
  })

  it('binds a continued note without emitting it', () => {
    const result = score('let foo <- C==')
    expect(result.duration.toFraction()).toBe('0')
    expect(result.events).toEqual([])
  })

  it('retunes a stored continued degree at playback', () => {
    const result = score('let foo <- 1d== $ {24edo} foo')
    const notes = result.events.filter((event) => event.kind === 'note')
    expect(notes.map((note) => note.pitch.value.valueOf())).toEqual([50])
  })

  it('preserves degree modifiers and the values of arithmetic results', () => {
    const stored =
      "let tone <- '2d $ let alias <- tone $ let scaled <- tone * 2/1 $ {24edo} alias scaled"
    const result = score(stored)
    expect(
      result.events.flatMap((event) =>
        event.kind === 'note' ? [event.pitch.value.valueOf()] : [],
      ),
    ).toEqual([1300, 2800])
  })

  it('does not continue a note across a rest at the end of a group', () => {
    const result = expandToBeatEvents(parse('(1 2 .)=='))

    expect(result.diagnostics).toMatchObject([
      { code: 'XP_CONTINUE_WITHOUT_ATTACK' },
      { code: 'XP_CONTINUE_WITHOUT_ATTACK' },
    ])
    expect('score' in result).toBe(false)
  })

  it('preserves non-attack shapes while holding a container', () => {
    const result = score('(@drone(5) 0 | 7)!')
    const notes = result.events.filter((event) => event.kind === 'note')
    const markers = result.events.filter((event) => event.kind === 'marker')

    expect(notes.map((note) => [note.start.toFraction(), note.duration.toFraction()])).toEqual([
      ['0', '2'],
      ['0', '2'],
      ['1', '1'],
    ])
    expect(markers.map((marker) => [marker.marker, marker.start.toFraction()])).toEqual([
      ['barline', '1'],
    ])
  })

  it('retains continuations on attack-free parenthesized groups', () => {
    const result = expandToBeatEvents(parse('(.)='))

    expect(result.diagnostics).toMatchObject([{ code: 'XP_CONTINUE_WITHOUT_ATTACK' }])
    expect('score' in result).toBe(false)
  })

  it.each([
    '(C, D E)= F',
    '(C, D E) = F',
    '(C D, E F)=',
    '(.. C, . D) =',
    '(C=, D)=',
    '(C ., D .) =',
    '(C, D E)=!',
    '(C=, D)=!',
    '(C, D E)! =',
    '((C, D E) =) -> F',
    'let phrase <- (C, D E) $ phrase =',
    'fn phrase() { ret (C, D E) } $ phrase()=',
  ])('requires branch-local continuations in %s', (source) => {
    const result = expandToBeatEvents(parse(source))
    expect(result.diagnostics).toMatchObject([
      {
        code: 'XP_UNEVEN_PARALLEL_CONTINUATION',
        locations: [{ start: { offset: source.lastIndexOf('=') } }],
      },
    ])
    expect('score' in result).toBe(false)
  })

  it('retains authored ratio labels for static renderers', () => {
    const result = score('3/2')
    expect(result.events).toHaveLength(1)
    expect(result.events[0]).toMatchObject({ kind: 'note', label: '3/2' })
  })

  it('retains exact offsets through tuplets and extends attached continuations', () => {
    const result = score('[C D E] F=')
    const notes = result.events.filter((event) => event.kind === 'note')

    expect(notes.map((note) => note.start.toFraction())).toEqual(['0', '1/3', '2/3', '1'])
    expect(notes.map((note) => note.duration.toFraction())).toEqual(['1/3', '1/3', '1/3', '2'])
    expect(result.duration.equals(3)).toBe(true)
    expect(notes[3]!.origins.map((origin) => origin.role)).toEqual(['literal', 'duration'])
  })

  it('can continue an attack whose entire original duration was removed', () => {
    const result = score('(C?) = D')
    expect(
      result.events.map((note) => [
        note.start.toFraction(),
        note.kind === 'note' && note.duration.toFraction(),
      ]),
    ).toEqual([
      ['0', '1'],
      ['1', '1'],
    ])
  })

  it('rejects a continuation without an active note', () => {
    const result = expandToBeatEvents(parse('= C'))

    expect(result.diagnostics).toMatchObject([
      {
        code: 'XP_CONTINUE_WITHOUT_ATTACK',
        severity: 'error',
        locations: [{ start: { offset: 0 }, end: { offset: 1 } }],
      },
    ])
    expect('score' in result).toBe(false)
  })

  it('clears the active note at a rest before resolving continuations', () => {
    const result = expandToBeatEvents(parse('C . = D'))

    expect(result.diagnostics).toMatchObject([{ code: 'XP_CONTINUE_WITHOUT_ATTACK' }])
    expect('score' in result).toBe(false)
  })

  it('expands repeats and preserves simultaneous branch timing', () => {
    const result = score('|:@x2 C, E G :|')
    const notes = result.events.filter((event) => event.kind === 'note')

    expect(notes.map((note) => note.start.toFraction())).toEqual(['0', '0', '1', '2', '2', '3'])
    expect(result.duration.equals(new Fraction(4))).toBe(true)
  })

  it.each([
    ['@2', '1/2'],
    ['@.', '1/2'],
  ])('expands repeated %s directives exactly like authored copies', (directive, duration) => {
    const repeated = score(`|: C D E F ${directive} G :|`)
    const expanded = score(`C D E F ${directive} G C D E F ${directive} G`)
    const timing = (result: ReturnType<typeof score>) =>
      result.events
        .filter((event) => event.kind === 'note')
        .map((event) => [event.start.toFraction(), event.duration.toFraction()])

    expect(timing(repeated)).toEqual(timing(expanded))
    expect(timing(repeated).at(-1)?.[1]).toBe(duration)
  })

  it.each([
    ['plain notes', '', 'C D E', 'F'],
    ['rests and continuations', 'A', 'C= . D', 'E'],
    ['normalized slots', '', '[C D] E', 'F'],
    ['explicit groups', 'A', '(C D) E', 'F'],
    ['parallel groups', '', '(C, E G) D', 'F'],
    ['subdivision changes', '@3', 'C @2 D E', 'F'],
    ['articulation shorthand', '', 'C D E F @. G', 'A'],
    ['dynamics', '@p', 'C @ff D', 'E'],
    ['pitch-context changes', '', '{root <- D} C E', 'G'],
    ['hard boundaries', 'A', 'C || D E', 'F'],
    ['nested repeats', '', 'C |:@x2 D :| E', 'F'],
    ['one-shot state across iterations', '', 'C @velocity(1/4)', 'D'],
    [
      'sequential declarations',
      'let division <- 2/1 $',
      'let division <- division + 1 $ @subdivision(division) C',
      'D',
    ],
    ['scoped function declarations', '', '(fn phrase() { ret C D } phrase())', 'F'],
  ])('matches authored copies for %s', (_description, prefix, repeatedBody, suffix) => {
    const repeated = `${prefix} |: ${repeatedBody} :| ${suffix}`
    const authored = `${prefix} ${repeatedBody} ${repeatedBody} ${suffix}`

    expect(audibleResult(repeated)).toEqual(audibleResult(authored))
  })

  it('matches authored copies across repeat counts and surrounding state', () => {
    const bodies = [
      'C D',
      'C= . D',
      '[C D] E',
      '(C, E G) D',
      'C @2 D',
      'C D E F @. G',
      '@p C @ff D',
      '{root <- D} C E',
      'C || D',
      'C |:@x2 D :| E',
    ]
    const surroundings = [
      ['', ''],
      ['A', 'F'],
      ['@3 A', 'F'],
      ['@p A', '@ff F'],
      ['{root <- E} A', 'F'],
    ]

    for (const body of bodies) {
      for (const [prefix, suffix] of surroundings) {
        for (const count of [1, 2, 3]) {
          const repeated = `${prefix} |:@x${count} ${body} :| ${suffix}`
          const copies = Array.from({ length: count }, () => body).join(' ')
          const authored = `${prefix} ${copies} ${suffix}`

          expect(audibleResult(repeated)).toEqual(audibleResult(authored))
        }
      }
    }
  })

  it.each([
    ['alternate endings', '|: C @2 D |¹ E :|² F ||', 'C @2 D E C @2 D F ||'],
    ['stateful endings', '|: @p C |¹ @ff D :|² E ||', '@p C @ff D @p C E ||'],
    ['nested ending body', '|: C |¹ |: D :| :|² E ||', 'C D D C E ||'],
    ['implicit repeat', 'C @2 D :| E', '|: C @2 D :| E'],
    ['chained implicit repeats', 'C :| D :|', 'C C D C C D'],
    [
      'declarations in alternate endings',
      '|: C |¹ let interval <- 3/2 $ interval :|² interval ||',
      'C let interval <- 3/2 $ interval C interval ||',
    ],
  ])('matches the authored expansion for %s', (_description, repeated, authored) => {
    expect(audibleResult(repeated)).toEqual(audibleResult(authored))
  })

  it('carries directives from a common repeat body into alternate endings', () => {
    const result = score('|: @p C |@^1 D :|@^2 E ||')

    expect(
      result.events
        .filter((event) => event.kind === 'note')
        .map((event) => event.dynamic.toFraction()),
    ).toEqual(['3/10', '3/10', '3/10', '3/10'])
  })

  it('incorporates prevailing dynamics into a single effective dynamic field', () => {
    const notes = score('C @ff D E').events.filter((event) => event.kind === 'note')

    expect(notes.map(({ dynamic }) => dynamic.toFraction())).toEqual(['1/2', '41/50', '41/50'])
  })

  it('incorporates a one-shot velocity into the same effective dynamic field', () => {
    const notes = score('@p C @velocity(4/5) D E').events.filter((event) => event.kind === 'note')

    expect(notes.map(({ dynamic }) => dynamic.toFraction())).toEqual(['3/10', '4/5', '3/10'])
  })
})
