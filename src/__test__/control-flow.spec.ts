import { describe, expect, it } from 'vitest'
import { parse } from '../parser.js'
import { expandToBeatEvents } from '../runtime/beat-events.js'
import { evaluateExpression } from '../runtime/expressions.js'
import { evaluateProgramShape } from '../runtime/score-shape.js'

function score(source: string) {
  const evaluated = expandToBeatEvents(parse(source))
  expect(evaluated.diagnostics).toEqual([])
  if (!('score' in evaluated)) throw new Error('Expected a beat-timed score.')
  return evaluated.score.events.flatMap((event) =>
    event.kind === 'note'
      ? [[event.start.toFraction(), event.duration.toFraction(), event.pitch.value.valueOf()]]
      : [],
  )
}

describe('comparison expressions', () => {
  it('keeps ordinary pitch spellings and the MOS accidental beside comparison operators', () => {
    expect(parse('eq @eq e').body[0]).toMatchObject({
      type: 'BinaryExpression',
      operator: '@eq',
      left: { type: 'PitchLiteral', raw: 'eq', accidentals: [{ value: 'q' }] },
      right: { type: 'PitchLiteral', raw: 'e' },
    })
    expect(parse('J@@eq J@').body[0]).toMatchObject({
      operator: '@eq',
      left: { type: 'PitchLiteral', raw: 'J@' },
      right: { type: 'PitchLiteral', raw: 'J@' },
    })
  })

  it.each([
    ['1 + 2 @eq 3', 1],
    ['1 @ne 1', 0],
    ['1 @lt 2', 1],
    ['2 @le 2', 1],
    ['1 @gt 2', 0],
    ['-2 @ge -3', 1],
    ['1s @eq 1000ms', 1],
    ['12d @eq 2/1', 1],
    ['E# @eq F', 0],
  ])('evaluates %s in the shared expression grammar', (source, expected) => {
    const result = evaluateExpression(parse(source).body[0]!)
    expect(result.diagnostics).toEqual([])
    expect('value' in result && result.value.value.valueOf()).toBe(expected)
  })

  it('reports incompatible dimensions and rejects unconsumed Booleans in a score', () => {
    expect(evaluateExpression(parse('1s @lt 1Hz').body[0]!).diagnostics[0]?.code).toBe(
      'XP_DIMENSION_MISMATCH',
    )
    expect(expandToBeatEvents(parse('1 @eq 1')).diagnostics[0]?.message).toMatch(
      /Boolean result cannot be played/,
    )
  })

  it.each([
    'true',
    'false',
    'let choice <- true $ choice',
    'fn choose(value: boolean) { ret value } $ choose(1)',
  ])('keeps %s Boolean through playback', (source) => {
    expect(expandToBeatEvents(parse(source)).diagnostics).toMatchObject([
      { code: 'XP_TYPE_MISMATCH', message: 'A Boolean result cannot be played as a note.' },
    ])
  })

  it('coerces zero and one to Boolean and rejects negative one', () => {
    const declaration = 'fn choose(value: boolean) { ret C if value else D } $ '
    expect(score(declaration + 'choose(0) choose(1)')).toEqual(score('D C'))
    expect(expandToBeatEvents(parse(declaration + 'choose(-1)')).diagnostics).toMatchObject([
      { code: 'XP_PARAMETER_COERCION' },
    ])
  })

  it.each(['2 ** 1024 @lt 2 ** 1025', '2 ** -1200 @gt 0', '2 ** -1200'])(
    'takes the true branch for %s',
    (condition) => {
      expect(score(`if(${condition}) { D } else { E }`)).toEqual(score('D'))
    },
  )
})

describe('higher-order calls', () => {
  it.each([
    ['let step <- (item) => item + 1d $ step(1d)', '2d'],
    ['let phrase <- (item) => (item . C) $ phrase(D)', 'D . C'],
    [
      'fn shift(item, interval: ratio <- 3/2) { ret item + interval } $ let alias <- shift $ alias(C)',
      'G',
    ],
    [
      'fn apply(callback, item) { ret callback(item) } $ fn keep(item) { ret item } $ apply(keep, D)',
      'D',
    ],
    [
      'fn shift(item, interval: ratio <- 3/2) { ret item + interval } $ arrayMap(shift, [C D])',
      '[G A]',
    ],
    ['fn ornament(item) { ret item . C } $ arrayMap(ornament, (D E))', 'D . C E . C'],
    [
      'fn sum(total: ratio, item: ratio) { ret total + item } $ let total <- arrayReduce(sum, [1/1 2/1 3/1], 0/1) $ if(total @eq 6) { C }',
      'C',
    ],
  ])('passes and plays functions in %s', (source, expected) => {
    expect(score(source)).toEqual(score(expected))
  })

  it('keeps distinct closures from the same lambda expression callable', () => {
    const source = `fn wrap(callback) { ret (item) => callback(item) }
let keep <- (item) => item
let wrapped <- wrap(wrap(keep))
wrapped(C)`
    expect(score(source)).toEqual(score('C'))
  })

  it('returns a named function with its enclosing parameters', () => {
    const source = `fn make(interval: ratio) {
  fn shift(item) { ret item + interval }
  ret shift
}
let shift <- make(3/2)
arrayMap(shift, [C D])`
    expect(score(source)).toEqual(score('[G A]'))
  })

  it.each([
    'let runner <- (next) => next(next) $ runner(runner)',
    'fn runner() { ret runner() } $ let alias <- runner $ alias()',
    'fn runner(item) { ret arrayMap(runner, [item]) } $ runner(C)',
  ])('guards recursion through a function value in %s', (source) => {
    expect(expandToBeatEvents(parse(source)).diagnostics).toMatchObject([{ code: 'XP_RECURSION' }])
  })

  it('checks callable arity and respects lexical shadowing', () => {
    for (const [source, code] of [
      ['let keep <- (item) => item $ keep()', 'XP_ARITY'],
      ['fn keep(item) { ret item } $ let keep <- C $ keep(D)', 'XP_NOT_CALLABLE'],
      ['fn keep(item) { ret item } $ keep', 'XP_TYPE_MISMATCH'],
    ] as const)
      expect(expandToBeatEvents(parse(source)).diagnostics).toMatchObject([{ code }])
  })

  it.each([
    ['arrayMap', '(item)', '[callback]'],
    ['arrayReduce', '(item, following)', '[callback callback]'],
  ])('keeps the recursion guard active inside %s', (builtin, parameters, arguments_) => {
    const source = `fn runner(callback) { ret ${builtin}(callback, ${arguments_}) }
let callback <- ${parameters} => runner(item)
runner(callback)`
    expect(expandToBeatEvents(parse(source)).diagnostics).toMatchObject([
      { code: 'XP_RECURSION', message: 'Recursive call to runner() is prohibited.' },
    ])
  })

  it.each([
    ['arrayMap', '(item)', '[C]'],
    ['arrayReduce', '(item, following)', '[C D]'],
  ])(
    'can invoke a closure after its creator has returned through %s',
    (builtin, parameters, arguments_) => {
      const source = `fn maker() { ret ${parameters} => maker() }
let callback <- maker()
let output <- ${builtin}(callback, ${arguments_})
C`
      expect(score(source)).toEqual(score('C'))
    },
  )

  it.each([
    ['arrayMap', '(item)', '[C]'],
    ['arrayReduce', '(item, following)', '[C D]'],
  ])(
    'preserves a callback error and its source location through %s',
    (builtin, parameters, arguments_) => {
      const source = `fn fail(item) { throw(<<callback failed>>) $ ret item }
${builtin}(${parameters} => fail(item), ${arguments_})`
      expect(expandToBeatEvents(parse(source)).diagnostics).toMatchObject([
        {
          code: 'XP_THROW',
          message: 'callback failed',
          locations: [
            { start: { offset: source.indexOf('fail(item)', source.indexOf('=>')) } },
            { start: { offset: source.indexOf('throw') } },
          ],
        },
      ])
    },
  )
})

describe('score control flow', () => {
  it.each([
    ['if(false @and missing()) { C } else { D }', 'D'],
    ['if(true @or missing()) { C } else { D }', 'C'],
    ['if(true @or false @and missing()) { C }', 'C'],
    ['if(1 @eq 1 @and @not false) { C }', 'C'],
    ['if(1::2 @or missing()) { C }', 'C'],
    [
      'let data <- record { tone: D, «text»: <<a>> + «b», nested: record { tone: E } } $ if(data[<<text>>] @eq «ab») { data[«tone»] data[<<nested>>][«tone»] }',
      'D E',
    ],
    ['if(«a🎶»[-1] @eq <<🎶>>) { C }', 'C'],
    ['fn choose(test) { if(test) { ret C . D } ret E } $ choose(true) choose(false)', 'C . D E'],
    ['fn choose() { for(item of [C D]) { ret item } } $ choose()', 'C'],
    ['fn choose() { while(true) { ret D } } $ choose()', 'D'],
    ['fn choose() { ret C $ throw(<<unreachable>>) } $ choose()', 'C'],
    ['try { C throw(«error») E } catch(message) { if(message @eq <<error>>) { D } } F', 'D F'],
    ['try { C D } catch { E } F', 'C D F'],
    ['try { let bad <- 1 / 0 } catch { D }', 'D'],
    ['try { @2 C throw(«error») } catch { D } F', 'D F'],
    ['try { if(true) { throw(<<stop>>) |:@x1000000 C :| } } catch { D }', 'D'],
    ['let note <- C $ try { note <- E $ throw(«error») } catch { note } note', 'C C'],
    ['let note <- C $ try { note <- D } catch { E } note', 'D'],
    [
      'fn choose(note) { try { note <- E $ throw(«error») } catch(message) { if(message @eq <<error>>) { ret note } } ret F } $ choose(D)',
      'D',
    ],
    ['fn choose() { try { ret C } catch { ret D } } $ choose()', 'C'],
    [
      'fn choose(note) { try { try { note <- D } catch { ret F } $ ret missingName } catch { ret note } } $ choose(C)',
      'C',
    ],
    ['fn choose() { try { ret missingName } catch { ret C } } $ choose()', 'C'],
    [
      'fn choose(note) { try { note <- E $ ret (F . missingName) } catch { ret note . D } } $ choose(C)',
      'C . D',
    ],
    [
      'fn choose() { try { try { ret missingName } catch { ret 1 / 0 } } catch { ret C } } $ let note <- choose() $ note',
      'C',
    ],
    ['fn choose() { try { ret missingName } catch { ret (3/2 2/1) } } $ {choose()} 1 2', '3/2 2/1'],
    [
      'fn choose() { try { ret 1::missingName } catch(message) { if(message @eq «Undefined name missingName.») { ret (3/2 2/1) } } } $ {choose()} 1 2',
      '3/2 2/1',
    ],
    ['for(item of [C D]) { try { item break } catch { E } } F', 'C F'],
  ])('evaluates data and control flow in %s', (source, expected) => {
    expect(score(source)).toEqual(score(expected))
  })

  it.each([
    ['throw(<<bad>> + « note»)', 'XP_THROW'],
    ['throw(1d)', 'XP_TYPE_MISMATCH'],
    ['ret C', 'XP_RETURN_SCOPE'],
    ['try { ret C } catch { D }', 'XP_RETURN_SCOPE'],
    ['fn choose() { if(false) { ret C } } $ choose()', 'XP_MISSING_RETURN'],
    ['try { while(true) {} } catch { C }', 'XP_EXPANSION_LIMIT'],
    ['fn choose() { try { ret choose() } catch { ret C } } $ choose()', 'XP_RECURSION'],
    [
      'fn choose() { try { ret 1::choose() } catch { ret (3/2 2/1) } } $ {choose()} 1 2',
      'XP_RECURSION',
    ],
    [
      'fn choose() { try { ret 1::choose() } catch { ret (3/2 2/1) } } $ try { {choose()} 1 2 } catch { C }',
      'XP_RECURSION',
    ],
    [
      'fn choose() { try { ret 1::10002 } catch { ret (3/2 2/1) } } $ try { {choose()} 1 2 } catch { C }',
      'XP_EXPANSION_LIMIT',
    ],
  ])('keeps unhandled diagnostics for %s', (source, code) => {
    expect(expandToBeatEvents(parse(source), { expansionLimit: 100 }).diagnostics).toMatchObject([
      { code },
    ])
  })

  it('updates an existing binding without moving the score cursor', () => {
    expect(score('let note <- C $ note $ note <- D $ note')).toEqual(score('C D'))
    expect(expandToBeatEvents(parse('missingName <- C')).diagnostics[0]).toMatchObject({
      code: 'XP_ASSIGNMENT',
    })
  })

  it('keeps updates to outer score variables across iterations and discards local shadows', () => {
    const source = `
let total <- 0/1
for (index in [C D E]) {
  if (index @gt 0) { total <- total + index }
  let total <- 10/1
  total <- total + 1
}
if (total @eq 3) { D }
`
    expect(score(source)).toEqual(score('D'))
    expect(score('let total <- 0/1 while(total @lt 2) { C total <- total + 1 }')).toEqual(
      score('C C'),
    )
  })

  it('evaluates comparisons in declarations and only visits the selected branch', () => {
    const source = `
let chosen <- 1 + 2 @eq 3
if(false) { |: @x1000000 C :| }
elif(chosen) { @2 D E }
elif(missingName) { G }
else { missingName }
F
`
    expect(score(source)).toEqual(score('@2 D E F'))
    expect(evaluateProgramShape(parse(source)).diagnostics).toEqual([])
  })

  it('plays nested loop results in order and restores shadowed variables', () => {
    const source = `
let index <- 9/1
for(index in [C D E F]) {
  if(index @eq 1) {
    let pass <- 0/1
    while(pass @lt 2) {
      E
      let pass <- pass + 1
    }
  } else {
    D
  }
}
if(index @eq 9) { F }
`
    expect(score(source)).toEqual(score('D E E D D F'))
    const notation = evaluateProgramShape(parse(source))
    expect(notation.diagnostics).toEqual([])
    expect('shape' in notation && notation.shape.duration.toFraction()).toBe('6')
  })

  it('distinguishes a block after a note from the inline conditional', () => {
    expect(score('C if (true) { D } else { E } F')).toEqual(score('C D F'))
    expect(score('C if (false) else D')).toEqual(score('D'))
  })

  it('nests a control block and a tuning change inside a function body', () => {
    expect(
      score('fn phrase() { ret if(true) { {19edo} 1d } else { missingName } } phrase()'),
    ).toEqual(score('{19edo} 1d'))
  })

  it('expands ordinary repeats only in a selected body during playback', () => {
    expect(score('if(true) { |: C D :| } E')).toEqual(score('C D C D E'))
  })

  it('compares the sounding pitches in the active tuning', () => {
    expect(score('{12edo} if(E# @eq F) { D } else { C }')).toEqual(score('{12edo} D'))
  })

  it('carries while bindings between iterations and restores them on exit', () => {
    const source = `
let cursor <- 0/1
while(cursor @lt 3) {
  C
  let cursor <- cursor + 1
}
if(cursor @eq 0) { D }
`
    expect(score(source)).toEqual(score('C C C D'))
  })

  it('carries prevailing context out of a while with no local declarations', () => {
    expect(score('{19edo} while(C# - C @lt 90c) { @2 {12edo} C } D')).toEqual(
      score('@2 {12edo} C D'),
    )
  })

  it('uses indices to look up container entries and values to play them directly', () => {
    const source = 'let melody <- [D F C] '
    const indexed = 'for(index in melody) { melody[index] }'
    const each = 'for(note of melody) { note }'
    expect(score(source + indexed)).toEqual(score('D F C'))
    expect(score(source + each)).toEqual(score('D F C'))
  })

  it('evaluates the collection once in the enclosing pitch context', () => {
    expect(score('{12edo} for(note of [1d 2d]) { {19edo} note }')).toEqual(
      score('{12edo} let melody <- [1d 2d] $ {19edo} melody[0] melody[1]'),
    )
  })

  it('does not evaluate empty containers or an initially false while body', () => {
    expect(
      score(
        'while(false) { missingName } for(index in []) { missingName } for(note of []) { missingName } D',
      ),
    ).toEqual(score('D'))
  })

  it('rejects counted loops and diagnoses non-container operands', () => {
    expect(() => parse('for(index, 0, 2) { C }')).toThrow('but "," found')
    for (const mode of ['in', 'of']) {
      const source = `for(index ${mode} 3/2) { C }`
      const result = expandToBeatEvents(parse(source))
      expect(result.diagnostics[0]).toMatchObject({
        code: 'XP_NOT_ITERABLE',
        locations: [{ start: { offset: source.indexOf('3/2') } }],
      })
    }
  })

  it('uses one expansion budget across nested loops', () => {
    for (const source of [
      'while(true) {}',
      'for(i in [C D E F]) { for(note of [C D E F]) { note } }',
    ]) {
      expect(expandToBeatEvents(parse(source), { expansionLimit: 8 }).diagnostics[0]?.code).toBe(
        'XP_EXPANSION_LIMIT',
      )
    }
  })
})

describe('loop jumps and completion', () => {
  it.each(['for(index in [C D])', 'for(note of [C D])', 'while(true)'])(
    'preserves the music before a break and skips the else for %s',
    (header) => {
      const source = `${header} { @2 C if(true) { break } missingName } else { missingName } D`
      expect(score(source)).toEqual(score('@2 C D'))
      const notation = evaluateProgramShape(parse(source))
      expect(notation.diagnostics).toEqual([])
      expect('shape' in notation && notation.shape.duration.toFraction()).toBe('1')
    },
  )

  it.each(['for(index in [])', 'for(note of [])', 'while(false)'])(
    'runs the else after zero iterations for %s',
    (header) => {
      expect(score(`${header} { missingName } else { C } D`)).toEqual(score('C D'))
    },
  )

  it.each(['for(index in [C D])', 'for(note of [C D])'])(
    'runs the else after continuing the final iteration for %s',
    (header) => {
      expect(score(`${header} { C continue missingName } else { E } F`)).toEqual(score('C C E F'))
    },
  )

  it('carries while bindings through continue and restores the outer scope before else', () => {
    const source = `
let index <- 0/1
while(index @lt 2) {
  let index <- index + 1
  C continue missingName
} else {
  if(index @eq 0) { D }
}
E
`
    expect(score(source)).toEqual(score('C C D E'))
  })

  it('targets the innermost body and treats an inner else as part of the outer body', () => {
    const source = `
for(note of [C D]) {
  note
  while(true) { E break } else { missingName }
  while(false) { missingName } else { continue }
  missingName
} else { F }
G
`
    expect(score(source)).toEqual(score('C E D E F G'))
  })

  it('stops a sequential group and skips repeat expansion after the jump', () => {
    const source = 'while(true) { (C break missingName) |: @x1000000 E :| } D'
    expect(score(source)).toEqual(score('C D'))
    expect(evaluateProgramShape(parse(source)).diagnostics).toEqual([])
  })

  it('keeps a jump inside ordinary repeat notation bound to the enclosing loop', () => {
    const source = 'while(true) { |: C break missingName :| } else { missingName } D'
    expect(score(source)).toEqual(score('C D'))
    expect(evaluateProgramShape(parse(source)).diagnostics).toEqual([])
  })

  it.each([
    'break',
    'continue',
    'while(false) { C } else { break }',
    'fn phrase() { ret break } while(true) { phrase() }',
    'while(true) { (C, continue) }',
    'while(true) { [C break] }',
  ])('diagnoses an evaluated jump outside its loop body in %s', (source) => {
    expect(expandToBeatEvents(parse(source)).diagnostics[0]?.code).toBe('XP_LOOP_JUMP')
  })
})
