import { Fraction } from 'xen-dev-utils/fraction'
import type { Expression, Node } from '../parser.generated.js'
import type { Diagnostic } from '../diagnostics.js'
import { catchableDiagnostic, EvaluationError } from '../diagnostics.js'
import { isPositiveRationalRatio, Value } from '../value.js'
import {
  evaluateDeclaration,
  evaluateExpression,
  evaluateThrow,
  isTruthy,
  preludeEnvironment,
  evaluateFunctionCall,
  stringValue,
} from './expressions.js'
import {
  expandRepeatsFrom,
  repeatBoundaryLocation,
  resolveRepeatChain,
} from './repeat-expansion.js'
import {
  broadcastScalarOperation,
  expandEnumeratedChord,
  type ScoreExpression,
} from './score-operations.js'
import type { ExpressionEvaluationResult } from './expressions.js'
import { DYNAMIC_VELOCITIES, resolveDirective } from './directives.js'
import { Visitor, type VisitorEvaluation } from './visitor.js'
import { contextAt } from './initialization.js'
import { layoutNotes } from './note-layout.js'
import { materializeScoreContinuations, tieScoreShapes } from './ties.js'
import { EMPTY_LEXICAL_ENVIRONMENT, extendLexicalEnvironment, isCallableValue } from './types.js'
import {
  DEFAULT_PITCH_CONTEXT,
  applyPitchContextChange,
  evaluatePitchLiteral,
  mapFormula,
  normalizeStaffAccidental,
} from './pitches.js'
import type {
  AttackShape,
  EvaluatedLiteral,
  ExpansionPath,
  AttackAppearance,
  AnnotationShape,
  BarlineShape,
  BarlineStyle,
  ContinueShape,
  ParallelShape,
  RestShape,
  ScoreShape,
  SequenceShape,
  SourceOrigin,
  PitchContext,
  DynamicMark,
  DirectiveExtensionState,
  ScoreShapeOptions,
  LexicalEnvironment,
  ScoreShapeEvaluationResult,
  ScoreVisitorContext,
} from './types.js'

interface PlaybackAttackShape extends AttackShape {
  readonly dynamic: DynamicMark
  readonly velocity: Fraction
  readonly velocityExplicit?: boolean
}

interface ContextResolver {
  readonly parent?: ContextResolver
  readonly change?: (context: ScoreVisitorContext, base: ScoreVisitorContext) => ScoreVisitorContext
  readonly cache: WeakMap<ScoreVisitorContext, ScoreVisitorContext>
}

function resolveContext(resolver: ContextResolver, base: ScoreVisitorContext): ScoreVisitorContext {
  const pending: ContextResolver[] = []
  let current: ContextResolver | undefined = resolver
  let context = base
  while (current) {
    const cached = current.cache.get(base)
    if (cached) {
      context = cached
      break
    }
    pending.push(current)
    current = current.parent
  }
  for (const layer of pending.reverse()) {
    context = layer.change?.(context, base) ?? context
    layer.cache.set(base, context)
  }
  return context
}

type LoopFrame = { jump?: Extract<Expression, { type: 'LoopJump' }>['action'] }

interface TimelineVisit {
  readonly key: string
  readonly offset: Fraction
  readonly beat: Fraction
  readonly children: Map<string, number>
  readonly parent?: TimelineVisit
}

interface TimelinePass {
  readonly beats: ReadonlyMap<string, Fraction>
  readonly sources: Map<unknown, number>
  readonly attacks: WeakMap<AttackShape['pitch'], TimelineVisit>
}

interface VisitorScope {
  readonly declarationScope: object
  readonly expansionPath: ExpansionPath
  readonly stopOnError?: boolean
  readonly loop?: LoopFrame
  readonly offset: Fraction
  readonly timeScale: Fraction
  readonly layout?: boolean
  readonly timelineVisit?: TimelineVisit
  readonly lockedPulse?: Fraction
  readonly base: ScoreVisitorContext
  readonly resolve: ContextResolver
  readonly subdivisionContext: ContextResolver
  readonly tempo?: Fraction
  readonly timeSignature?: ScoreVisitorContext['timeSignature']

  readonly context: PitchContext
  readonly pulse: Fraction
  readonly dynamic: DynamicMark
  readonly articulation: Fraction
  readonly articulationMarks: readonly string[]
  readonly directiveState: DirectiveExtensionState
  readonly environment?: LexicalEnvironment
}

type ScoreVisitor = Visitor<ScoreExpression, VisitorScope, ScoreShapeEvaluationResult>

function withOccurrence(shape: ScoreShape, visitor: ScoreVisitor): ScoreShape {
  const { expansionPath } = visitor.scope
  return expansionPath.length ? { ...shape, expansionPath } : shape
}

const MAX_REPEAT_EXPANSION_NODES = 100_000

function repeatCount(node: Extract<Expression, { type: 'Repeat' }>): number | undefined {
  let count: bigint
  try {
    count = node.count ? BigInt(String(node.count.value)) : 2n
  } catch {
    return undefined
  }
  let longestEnding = 0
  for (const ending of node.endings) {
    if (ending.body.length > longestEnding) longestEnding = ending.body.length
  }
  const expandedNodes = count * BigInt(Math.max(1, node.body.length + longestEnding))
  if (count < 0n || expandedNodes > BigInt(MAX_REPEAT_EXPANSION_NODES)) return undefined
  return Number(count)
}

const repeatEndingBodies = new WeakMap<
  Extract<Expression, { type: 'Repeat' }>,
  Map<bigint, Expression[]>
>()

function appendRepeatItems(result: Expression[], items: readonly Expression[]) {
  for (const item of items) {
    if (item.type === 'Sequence') {
      for (const child of item.items) result.push(child)
    } else result.push(item)
  }
}

function repeatBody(
  node: Extract<Expression, { type: 'Repeat' }>,
  iteration: number,
): readonly Expression[] {
  let endings = repeatEndingBodies.get(node)
  if (!endings) {
    endings = new Map()
    for (const ending of node.endings) {
      const number = BigInt(ending.number.value)
      if (!endings.has(number)) endings.set(number, ending.body)
    }
    repeatEndingBodies.set(node, endings)
  }
  const result: Expression[] = []
  if (iteration > 0) appendRepeatItems(result, node.replayPrefix ?? [])
  appendRepeatItems(result, node.body)
  appendRepeatItems(result, endings.get(BigInt(iteration + 1)) ?? [])
  return result
}

function hasShape(
  result: ScoreShapeEvaluationResult,
): result is { readonly shape: ScoreShape; readonly diagnostics: readonly Diagnostic[] } {
  return 'shape' in result
}

function origin(node: Node, role: SourceOrigin['role'] = 'structural'): SourceOrigin {
  return { location: node.location, role }
}

function sequence(
  children: readonly ScoreShape[],
  origins: readonly SourceOrigin[],
): SequenceShape {
  return {
    kind: 'sequence',
    children,
    duration: children.reduce((duration, child) => duration.add(child.duration), new Fraction(0)),
    origins,
  }
}

/** Retain the use site on notes produced by a function or stored fragment. */
function annotateScoreUse(shape: ScoreShape, callOrigin: SourceOrigin): ScoreShape {
  if (shape.kind === 'attack') return { ...shape, origins: [...shape.origins, callOrigin] }
  if (shape.kind === 'sequence')
    return {
      ...shape,
      children: shape.children.map((child) => annotateScoreUse(child, callOrigin)),
    }
  if (shape.kind === 'parallel')
    return {
      ...shape,
      branches: shape.branches.map((branch) => annotateScoreUse(branch, callOrigin)),
    }
  if (shape.kind === 'drone' && shape.template)
    return { ...shape, template: annotateScoreUse(shape.template, callOrigin) }
  return shape
}

function generatedRest(duration: Fraction): RestShape {
  return { kind: 'rest', duration, generated: true, origins: [] }
}

function barline(node: Expression, style: BarlineStyle, endingNumber?: number): BarlineShape {
  return {
    kind: 'barline',
    style,
    duration: new Fraction(0),
    origins: [origin(node)],
    endingNumber,
  }
}

function repeatMarker(
  node: Extract<Expression, { type: 'Repeat' }>,
  edge: 'start' | 'end',
  style: BarlineStyle,
): BarlineShape {
  return barline({ ...node, location: repeatBoundaryLocation(node, edge) }, style)
}

function endingMarker(
  node: Extract<Expression, { type: 'Repeat' }>,
  ending: Extract<Expression, { type: 'Repeat' }>['endings'][number],
  _index: number,
  style: 'ending-start' | 'repeat-end' = 'ending-start',
): BarlineShape {
  const markerLocation = ending.markerLocation
  return barline(
    {
      ...node,
      location: {
        source: node.location.source,
        start: markerLocation.start,
        end: markerLocation.end,
      },
    },
    style,
    style === 'ending-start' ? Number(ending.number.value) : undefined,
  )
}

function pad(shape: ScoreShape, duration: Fraction): ScoreShape {
  const missing = duration.sub(shape.duration)
  if (!missing.n) return shape
  return sequence([shape, generatedRest(missing)], shape.origins)
}

function mapAttacks(shape: ScoreShape, update: (attack: AttackShape) => AttackShape): ScoreShape {
  switch (shape.kind) {
    case 'attack':
      return update(shape)
    case 'sequence':
      return { ...shape, children: shape.children.map((child) => mapAttacks(child, update)) }
    case 'parallel':
      return { ...shape, branches: shape.branches.map((branch) => mapAttacks(branch, update)) }
    default:
      return shape
  }
}

function scaleShape(shape: ScoreShape, factor: Fraction): ScoreShape {
  const duration = shape.duration.mul(factor)
  switch (shape.kind) {
    case 'sequence':
      return {
        ...shape,
        duration,
        children: shape.children.map((child) => scaleShape(child, factor)),
      }
    case 'parallel':
      return {
        ...shape,
        duration,
        branches: shape.branches.map((branch) => scaleShape(branch, factor)),
      }
    default:
      return { ...shape, duration }
  }
}

function resizeShape(shape: ScoreShape, duration: Fraction): ScoreShape {
  if (shape.duration.n) return scaleShape(shape, duration.div(shape.duration))
  if (shape.kind === 'parallel')
    return {
      ...shape,
      duration,
      branches: shape.branches.map((branch) => resizeShape(branch, duration)),
    }
  if (shape.kind === 'sequence') {
    // A grace group may have been cut all the way to zero. Its first sounding
    // item takes the grace span, and the rest keep their coincident onsets.
    const first = shape.children.findIndex((child) => attacks(child).length)
    return {
      ...shape,
      duration,
      children: shape.children.map((child, index) =>
        index === first ? resizeShape(child, duration) : child,
      ),
    }
  }
  return { ...shape, duration }
}

/** Clip each written slot, including sounds that extend past the enclosing slot. */
function trimShape(shape: ScoreShape, cutoff: Fraction): ScoreShape {
  const duration = shape.duration.compare(cutoff) <= 0 ? shape.duration : cutoff
  if (shape.kind === 'parallel')
    return {
      ...shape,
      duration,
      branches: shape.branches.map((branch) => trimShape(branch, duration)),
    }
  if (shape.kind === 'sequence') {
    let remaining = duration
    const children = shape.children.map((child) => {
      const kept = trimShape(child, remaining)
      remaining = remaining.sub(kept.duration)
      return kept
    })
    return { ...shape, duration, children }
  }
  return { ...shape, duration }
}

type PitchTree =
  | { kind: 'attack'; attack: AttackShape }
  | { kind: 'sequence' | 'parallel'; children: PitchTree[] }

function pitchTree(shape: ScoreShape): PitchTree | undefined {
  if (shape.kind === 'attack') return { kind: 'attack', attack: shape }
  if (shape.kind !== 'sequence' && shape.kind !== 'parallel') return undefined
  const children = (shape.kind === 'sequence' ? shape.children : shape.branches)
    .map(pitchTree)
    .filter((child): child is PitchTree => Boolean(child))
  if (!children.length) return undefined
  if (children.length === 1) return children[0]
  return { kind: shape.kind, children }
}

function matchingPitchTrees(source: PitchTree, target: PitchTree): boolean {
  if (source.kind === 'attack' || target.kind === 'attack') return source.kind === target.kind
  return (
    source.kind === target.kind &&
    source.children.length === target.children.length &&
    source.children.every((child, index) => matchingPitchTrees(child, target.children[index]!))
  )
}

/** Sounding span for each attack, including attached continuation shapes. */
function attackSpans(shape: ScoreShape): Map<AttackShape, Fraction> {
  const spans = new Map<AttackShape, Fraction>()
  type State = { active: AttackShape[] }
  const visit = (current: ScoreShape, state: State) => {
    if (current.kind === 'attack') {
      spans.set(current, current.duration)
      state.active = [current]
    } else if (current.kind === 'continue')
      for (const attack of state.active) spans.set(attack, spans.get(attack)!.add(current.duration))
    else if (current.kind === 'rest') state.active = []
    else if (current.kind === 'sequence') current.children.forEach((child) => visit(child, state))
    else if (current.kind === 'parallel') {
      const states = current.branches.map((): State => ({ active: [] }))
      current.branches.forEach((branch, index) => visit(branch, states[index]!))
      state.active = states.flatMap((branch) => branch.active)
    }
  }
  visit(shape, { active: [] })
  return spans
}

function annotateRepeatAppearances(
  shape: ScoreShape,
  alternatives: readonly (readonly AttackAppearance[])[],
): ScoreShape {
  let attackIndex = 0
  const annotate = (current: ScoreShape): ScoreShape => {
    if (current.kind === 'attack') {
      const alternateAppearances = alternatives[attackIndex++]
      if (!alternateAppearances?.length) return current
      const notationValue = (pitch: AttackShape['pitch']) =>
        pitch.kind === 'absolutePitch' ? pitch.rootOffset : (pitch.notationValue ?? pitch.value)
      const ambiguous = alternateAppearances.some(
        (appearance) =>
          appearance.rootPitch.spelling.raw !== current.rootPitch.spelling.raw ||
          !notationValue(appearance.pitch).equals(notationValue(current.pitch)),
      )
      return {
        ...current,
        alternateAppearances,
        ...(ambiguous && !current.displayLabel
          ? { displayLabel: authoredLabels.get(current) }
          : {}),
      }
    }
    if (current.kind === 'sequence') return { ...current, children: current.children.map(annotate) }
    if (current.kind === 'parallel') return { ...current, branches: current.branches.map(annotate) }
    return current
  }
  return annotate(shape)
}

const authoredLabels = new WeakMap<AttackShape, string>()

function attacks(shape: ScoreShape): AttackShape[] {
  if (shape.kind === 'attack') return [shape]
  if (shape.kind === 'sequence') return shape.children.flatMap(attacks)
  if (shape.kind === 'parallel') return shape.branches.flatMap(attacks)
  return []
}

/**
 * Give every attack an independent sounding span while retaining the original
 * score tree. A one-branch parallel wrapper occupies the attack's authored
 * duration even when the wrapped attack sounds beyond it, so later onsets and
 * all non-attack shapes remain at their authored positions.
 */
function holdAttacks(
  shape: ScoreShape,
  duration: Fraction,
  extension: Fraction,
  markOrigins: readonly SourceOrigin[],
): ScoreShape | undefined {
  let attackCount = 0
  const hold = (current: ScoreShape, start: Fraction): ScoreShape => {
    if (current.kind === 'attack') {
      attackCount++
      const held: AttackShape = {
        ...current,
        duration: duration.sub(start),
        origins: [...current.origins, ...markOrigins],
      }
      return {
        kind: 'parallel',
        duration: current.duration,
        branches: [held],
        origins: current.origins,
      }
    }
    if (current.kind === 'sequence') {
      let offset = start
      const children = current.children.map((child) => {
        const result = hold(child, offset)
        offset = offset.add(child.duration)
        return result
      })
      return { ...current, children }
    }
    if (current.kind === 'parallel') {
      return { ...current, branches: current.branches.map((branch) => hold(branch, start)) }
    }
    return current
  }
  const held = hold(shape, new Fraction(0))
  if (!attackCount) return undefined
  if (!extension.n) return held
  return sequence([held, generatedRest(extension)], shape.origins)
}

function contextAnnotation(
  node: Extract<Expression, { type: 'PitchContextChange' }>,
): AnnotationShape {
  const pitchText = (pitch: Extract<Expression, { type: 'PitchLiteral' }>) => {
    let text = pitch.raw
    for (const accidental of [...pitch.accidentals].reverse()) {
      const glyph =
        {
          flat: '♭',
          sharp: '♯',
          natural: '♮',
          'double-flat': '𝄫',
          'double-sharp': '𝄪',
          'half-flat': '𝄳',
          'half-sharp': '𝄲',
        }[normalizeStaffAccidental(accidental.value)] ?? accidental.value
      const start = accidental.location.start.offset - pitch.location.start.offset
      const end = accidental.location.end.offset - pitch.location.start.offset
      text = text.slice(0, start) + glyph + text.slice(end)
    }
    return text
  }
  const text = node.statements
    .map((statement) => {
      if (statement.type === 'TuningStretch') return statement.raw
      if (statement.type !== 'ContextAssignment')
        return statement.type === 'ContextPreset' ? statement.raw : 'context'
      const target =
        statement.target.type === 'ContextNameTarget'
          ? statement.target.name
          : statement.target.type === 'ContextPitchTarget'
            ? pitchText(statement.target.pitch)
            : statement.target.operator
      const expressionText = (value: Expression): string => {
        if ('raw' in value) return String(value.raw)
        if (value.type === 'Identifier') return value.name
        if (value.type === 'UnaryExpression')
          return `${value.operator}${expressionText(value.operand)}`
        if (value.type === 'PitchModifierExpression')
          return `${value.modifier.raw}${expressionText(value.operand)}`
        if (value.type === 'BinaryExpression')
          return `${expressionText(value.left)} ${value.operator} ${expressionText(value.right)}`
        if (value.type === 'Group') return `(${expressionText(value.expression)})`
        return value.type
      }
      const value = expressionText(statement.value)
      if (statement.association === 'rootAsTarget') return `root as ${target}`
      if (statement.association === 'targetAsRoot') return `${target} as root`
      return `${target} = ${value}`
    })
    .join('; ')
  return { kind: 'annotation', text, duration: new Fraction(0), origins: [origin(node, 'context')] }
}

function contextShape(
  node: Extract<Expression, { type: 'PitchContextChange' }>,
  context: PitchContext,
  previousContext?: PitchContext,
): ScoreShape {
  const signatureDeclared = node.statements.some(
    (statement) =>
      statement.type === 'SignatureDeclaration' ||
      (statement.type === 'MosDeclaration' &&
        statement.elements.some((element) => element.type === 'SignatureDeclaration')),
  )
  const signatureShape = () => {
    let names = context.mos ? [...context.mos.nominals.keys()] : ['C', 'D', 'E', 'F', 'G', 'A', 'B']
    if (!context.mos) {
      const written = [...(context.signature?.values() ?? [])].flatMap((pitch) =>
        pitch.accidentals.map((accidental) => accidental.value),
      )
      const sharps = written.some((value) => ['#', '♯', 'x', '𝄪', 't', '‡', '𝄲'].includes(value))
      const flats = written.some((value) => ['b', '♭', '𝄫', 'd', '𝄳'].includes(value))
      if (sharps && !flats) names = ['F', 'C', 'G', 'D', 'A', 'E', 'B']
      else if (flats && !sharps) names = ['B', 'E', 'A', 'D', 'G', 'C', 'F']
    }
    const pitches = names.flatMap((name) => {
      let pitch = context.signature?.get(name)
      const decorated = (candidate: typeof pitch) =>
        candidate &&
        (candidate.accidentals.length || candidate.inflections.length || candidate.modifiers.length)
      if (!decorated(pitch)) {
        const previousPitch = previousContext?.signature?.get(name)
        if (!previousPitch || !decorated(previousPitch)) return []
        pitch = {
          ...previousPitch,
          modifiers: [],
          accidentals: [{ type: 'Accidental', value: '_', location: node.location }],
          inflections: [],
          raw: name,
        }
      }
      if (!pitch) return []
      const system: 'mos' | 'latin' = context.mos ? 'mos' : 'latin'
      const literal = {
        ...pitch,
        nominal: { ...pitch.nominal, value: name, system },
      }
      const value = evaluatePitchLiteral(literal, { ...context, signature: undefined })
      const spelling = value.spelling
      return spelling.accidentals?.length ||
        spelling.inflections?.length ||
        spelling.modifiers?.length
        ? [value]
        : []
    })
    return {
      kind: 'key-signature' as const,
      pitches,
      duration: new Fraction(0),
      origins: [origin(node, 'context')],
    }
  }
  if (node.statements.some((statement) => statement.type === 'MosDeclaration') && context.mos) {
    const large = [...context.mos.pattern].filter((step) => step === 'L').length
    const small = [...context.mos.pattern].filter((step) => step === 's').length
    const clef: ScoreShape = {
      kind: 'clef',
      clef:
        large === 5 && small === 2
          ? { kind: 'treble' }
          : { kind: 'diamond-mos', pattern: context.mos.pattern },
      duration: new Fraction(0),
      origins: [origin(node, 'context')],
    }
    if (!signatureDeclared) return clef
    return {
      kind: 'sequence',
      children: [clef, signatureShape()],
      duration: new Fraction(0),
      origins: [origin(node, 'context')],
    }
  }
  if (previousContext?.mos && !context.mos) {
    const clef: ScoreShape = {
      kind: 'clef',
      clef: { kind: 'treble' },
      duration: new Fraction(0),
      origins: [origin(node, 'context')],
    }
    if (!signatureDeclared) return clef
    return sequence([clef, signatureShape()], [origin(node, 'context')])
  }
  if (signatureDeclared) return signatureShape()
  return contextAnnotation(node)
}

function playablePitch(
  node: Expression,
  context: PitchContext,
  evaluated: ExpressionEvaluationResult,
):
  | {
      readonly pitch: AttackShape['pitch']
      readonly justIntonation?: boolean
      readonly diagnostics: readonly Diagnostic[]
    }
  | { readonly diagnostics: readonly Diagnostic[] } {
  if (!('value' in evaluated)) return evaluated
  if (isCallableValue(evaluated.value))
    return {
      diagnostics: [
        ...evaluated.diagnostics,
        {
          code: 'XP_TYPE_MISMATCH',
          severity: 'error',
          message: 'Call the function to play its result.',
          locations: [node.location],
        },
      ],
    }
  if (evaluated.value.kind === 'pitchOffset') {
    return {
      pitch: {
        ...evaluated.value,
        value: evaluated.value.value.add(context.rootDisplacement),
        notationValue: evaluated.value.value,
      },
      ...(context.mapping.id !== 'untempered' && evaluated.value.justIntonation
        ? { justIntonation: true }
        : {}),
      diagnostics: evaluated.diagnostics,
    }
  }
  if (evaluated.value.kind === 'absolutePitch') {
    const absoluteRootOffset = evaluated.value.rootOffset.add(
      mapFormula(context.rootPitch.formula, context.mapping),
    )
    return {
      pitch: {
        ...evaluated.value,
        rootOffset: absoluteRootOffset,
        value: evaluated.value.rootOffset.add(context.rootDisplacement),
      },
      diagnostics: evaluated.diagnostics,
    }
  }
  if (evaluated.value.kind === 'scalar' && evaluated.value.boolean)
    return {
      diagnostics: [
        ...evaluated.diagnostics,
        {
          code: 'XP_TYPE_MISMATCH',
          severity: 'error',
          message: 'A Boolean result cannot be played as a note.',
          locations: [node.location],
        },
      ],
    }
  const ratio = evaluated.value.value
  if (ratio.dimensions.equals({ seconds: -1 }) && ratio.valueOf() > 0) {
    const notationRatio = ratio.div(context.rootFrequency)
    return {
      pitch: {
        kind: 'frequency',
        frequency: ratio,
        value: Value.pitch(notationRatio).add(context.rootDisplacement),
        notationValue: Value.pitch(notationRatio),
        origins: evaluated.value.origins,
      },
      diagnostics: evaluated.diagnostics,
    }
  }
  if (!ratio.dimensions.isDimensionless || ratio.valueOf() <= 0) {
    return {
      diagnostics: [
        ...evaluated.diagnostics,
        {
          code: 'XP_TYPE_MISMATCH',
          severity: 'error',
          message: 'A score atom must be a pitch offset or positive ratio.',
          locations: [node.location],
        },
      ],
    }
  }
  const value = Value.pitch(ratio)
  const justIntonation = isPositiveRationalRatio(ratio)
  return {
    pitch: {
      kind: 'pitchOffset',
      value: value.add(context.rootDisplacement),
      notationValue: value,
      origins: evaluated.value.origins,
      ...(justIntonation && { justIntonation: true }),
    },
    ...(context.mapping.id !== 'untempered' && justIntonation ? { justIntonation: true } : {}),
    diagnostics: evaluated.diagnostics,
  }
}

/** Build the exact-duration score-shape tree for sequencing, parallelism, and slots. */
export function evaluateScoreSemantics(
  node: Expression,
  options: ScoreShapeOptions = {},
  playback = false,
): ScoreShapeEvaluationResult {
  const initialization = options.initialization
  if (!initialization?.changes?.length) {
    const result = evaluateScorePass(node, options, playback)
    if (playback || !hasShape(result)) return result
    const { diagnostics } = layoutNotes(result.shape)
    return diagnostics.length ? { diagnostics: [...result.diagnostics, ...diagnostics] } : result
  }

  const offset = options.beatOffset ?? new Fraction(0)
  const sources = new Map<unknown, number>()
  let beats = new Map<string, Fraction>()
  // Continuations and grace notes can move attacks after their operands are
  // evaluated. Revisit affected expressions at the beats found by note layout.
  for (let attempt = 0; attempt < 32; attempt++) {
    const attacks: TimelinePass['attacks'] = new WeakMap()
    const result = evaluateScorePass(node, options, playback, { sources, beats, attacks })
    if (!hasShape(result)) return result
    const placements = new Map<TimelineVisit, Fraction>()
    const layout = layoutNotes(result.shape)
    for (const note of layout.notes) {
      const visit = attacks.get(note.pitch)
      if (!visit) continue
      const beat = offset.add(note.start)
      // A call or group that starts on this attack reads the same grid beat.
      // An enclosing expression that starts earlier retains its own context.
      for (
        let owner: TimelineVisit | undefined = visit;
        owner?.offset.equals(visit.offset);
        owner = owner.parent
      ) {
        const previous = placements.get(owner)
        if (!previous || beat.compare(previous) < 0) placements.set(owner, beat)
      }
    }
    const next = new Map<string, Fraction>()
    let changed = false
    for (const [visit, beat] of placements) {
      if (contextAt(initialization, beat) !== contextAt(initialization, visit.beat)) changed = true
      if (!beat.equals(visit.offset)) next.set(visit.key, beat)
    }
    if (!changed)
      return layout.diagnostics.length
        ? { diagnostics: [...result.diagnostics, ...layout.diagnostics] }
        : result
    beats = next
  }
  return {
    diagnostics: [
      {
        code: 'XP_TIMELINE_LAYOUT',
        severity: 'error',
        message: 'Timed context changes do not produce stable expanded note positions.',
        locations: [node.location],
      },
    ],
  }
}

function evaluateScorePass(
  node: Expression,
  options: ScoreShapeOptions,
  playback: boolean,
  timeline?: TimelinePass,
): ScoreShapeEvaluationResult {
  const inherited = contextAt(options.initialization, options.beatOffset ?? new Fraction(0))
  options = {
    ...inherited,
    ...Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
  }
  const pulse = new Fraction(options.pulse ?? 1)
  if (pulse.compare(0) <= 0) throw new RangeError('pulse must be positive.')
  const extensions = new Map(
    (options.directiveExtensions ?? []).map((extension) => [
      extension.name.toLowerCase(),
      extension,
    ]),
  )
  if (extensions.size !== (options.directiveExtensions ?? []).length)
    throw new RangeError('Directive extension names must be unique.')
  const extensionInitialState: Record<string, unknown> = {}
  for (const [name, extension] of extensions) {
    const stateKey = extension.stateKey?.toLowerCase() ?? name
    if (!(stateKey in extensionInitialState) || extensionInitialState[stateKey] === undefined) {
      extensionInitialState[stateKey] = extension.initialState
    } else if (
      extension.initialState !== undefined &&
      !Object.is(extensionInitialState[stateKey], extension.initialState)
    ) {
      throw new RangeError(
        `Directive extensions sharing state key "${stateKey}" must share an initializer.`,
      )
    }
  }
  const initialDirectiveState: DirectiveExtensionState = {
    ...extensionInitialState,
    ...options.directiveState,
  }

  const applyExtension = (
    directive: Extract<Expression, { type: 'Directive' }>,
    context: PitchContext,
    state: DirectiveExtensionState,
  ): { state: DirectiveExtensionState; diagnostics: readonly Diagnostic[] } | undefined => {
    const extension = extensions.get(directive.name)
    if (!extension) return undefined
    const stateKey = extension.stateKey?.toLowerCase() ?? directive.name
    try {
      const result = extension.apply(directive, context, state[stateKey])
      return {
        state: { ...state, [stateKey]: result.state },
        diagnostics: result.diagnostics ?? [],
      }
    } catch (error) {
      return {
        state,
        diagnostics: [
          {
            code: 'XP_DIRECTIVE_EXTENSION',
            severity: 'error',
            message: error instanceof Error ? error.message : `Invalid @${directive.name}.`,
            locations: [directive.location],
          },
        ],
      }
    }
  }

  const resultVisitors = new WeakMap<ScoreShapeEvaluationResult, ScoreVisitor>()
  const withVisitor = (result: ScoreShapeEvaluationResult, visitor: ScoreVisitor) => {
    resultVisitors.set(result, visitor)
    return result
  }
  const visitorAfter = (result: ScoreShapeEvaluationResult, visitor: ScoreVisitor) => {
    const next = resultVisitors.get(result) ?? visitor
    // Musical state can escape the child, while its repeat and visit identities end there.
    return next.scope.expansionPath === visitor.scope.expansionPath &&
      next.scope.timelineVisit === visitor.scope.timelineVisit
      ? next
      : next.spawn({
          expansionPath: visitor.scope.expansionPath,
          timelineVisit: visitor.scope.timelineVisit,
        })
  }

  const visitorContext = (visitor: ScoreVisitor): ScoreVisitorContext => ({
    tempo: visitor.scope.tempo,
    timeSignature: visitor.scope.timeSignature,
    pitchContext: visitor.scope.context,
    pulse: visitor.scope.pulse,
    dynamic: visitor.scope.dynamic,
    articulation: visitor.scope.articulation,
    articulationMarks: visitor.scope.articulationMarks,
    directiveState: visitor.scope.directiveState,
    lexicalEnvironment: visitor.scope.environment,
  })

  const contextScope = (context: ScoreVisitorContext) => ({
    tempo: context.tempo,
    timeSignature: context.timeSignature,
    context: context.pitchContext,
    pulse: context.pulse,
    dynamic: context.dynamic,
    articulation: context.articulation,
    articulationMarks: context.articulationMarks,
    directiveState: context.directiveState,
    environment: context.lexicalEnvironment,
  })

  const changeVisitor = (
    visitor: ScoreVisitor,
    change: (context: ScoreVisitorContext, base: ScoreVisitorContext) => ScoreVisitorContext,
  ) => {
    const resolve: ContextResolver = { parent: visitor.scope.resolve, change, cache: new WeakMap() }
    return visitor.spawn({ ...contextScope(resolveContext(resolve, visitor.scope.base)), resolve })
  }

  const at = (
    visitor: ScoreVisitor,
    offset: Fraction,
    expansionPath = visitor.scope.expansionPath,
    contextBeat = offset,
  ): ScoreVisitor => {
    let base = visitor.scope.layout
      ? visitor.scope.base
      : (contextAt(options.initialization, contextBeat) ?? visitor.scope.base)
    if (base === visitor.scope.base) return visitor.spawn({ offset, expansionPath })
    if (visitor.scope.lockedPulse && !base.pulse.equals(visitor.scope.lockedPulse))
      base = { ...base, pulse: visitor.scope.lockedPulse }
    return visitor.spawn({
      ...contextScope(resolveContext(visitor.scope.resolve, base)),
      base,
      offset,
      expansionPath,
    })
  }

  const inheritedMeasureAt = (offset: Fraction) => {
    let measure = options.timeSignature
      ? {
          length: new Fraction(
            options.timeSignature.numerator * 4,
            options.timeSignature.denominator,
          ),
          origin: new Fraction(0),
        }
      : undefined
    for (const change of options.timeSignatureChanges ?? []) {
      const origin = new Fraction(change.beat)
      if (origin.compare(offset) > 0) break
      measure = { length: new Fraction(change.numerator * 4, change.denominator), origin }
    }
    return measure
  }

  const withVisitorContext = (shape: ScoreShape, visitor: ScoreVisitor): ScoreShape => ({
    ...withOccurrence(shape, visitor),
    visitorContextChange: visitorContext(visitor),
  })

  const flowLimit = options.expansionLimit ?? MAX_REPEAT_EXPANSION_NODES
  let flowBudget = flowLimit
  const spendFlowBudget = (current: Expression) => {
    if (--flowBudget >= 0) return
    throw new EvaluationError([
      {
        code: 'XP_EXPANSION_LIMIT',
        severity: 'error',
        message: `Control flow exceeded the ${flowLimit}-step expansion limit.`,
        locations: [current.location],
      },
    ])
  }

  const expandBlockRepeats = (
    body: Extract<Expression, { type: 'Sequence' }>,
    defer: boolean,
    path: ExpansionPath,
  ) =>
    expandRepeatsFrom(
      path,
      { type: 'Program', source: '', comments: [], body: body.items, location: body.location },
      { expansionLimit: flowLimit, preserveBarlines: true },
      () => spendFlowBudget(body),
      defer,
    )

  const visitBlock = (
    body: Extract<Expression, { type: 'Sequence' }>,
    visitor: ScoreVisitor,
    deferRepeats = visitor.scope.loop !== undefined || visitor.scope.stopOnError === true,
    declarationScope = {},
  ): ScoreShapeEvaluationResult => {
    spendFlowBudget(body)
    let diagnostics: readonly Diagnostic[] = []
    if (playback) {
      const expanded = expandBlockRepeats(body, deferRepeats, visitor.scope.expansionPath)
      diagnostics = expanded.diagnostics
      if (!expanded.program) return { diagnostics }
      body = { ...body, items: [...expanded.program.body] }
    } else {
      const items: Expression[] = []
      appendRepeatItems(items, body.items)
      body = { ...body, items }
    }

    const evaluated = visitor.visit(body, {
      subdivisionContext: visitor.scope.resolve,
      declarationScope,
    })
    return withVisitor(
      { ...evaluated, diagnostics: [...diagnostics, ...evaluated.diagnostics] },
      visitorAfter(evaluated, visitor),
    )
  }

  // Copy the path to the updated binding. Earlier shapes keep their lexical
  // snapshots, and block exit can recognize updated versions of outer frames.
  const originalFrames = new WeakMap<LexicalEnvironment, LexicalEnvironment>()
  const originalFrame = (scope: LexicalEnvironment) => originalFrames.get(scope) ?? scope
  const preludeFrames = new Set<LexicalEnvironment>()
  const assignBinding = (
    environment: LexicalEnvironment | undefined,
    name: string,
    value: EvaluatedLiteral,
  ): LexicalEnvironment | undefined => {
    if (!preludeFrames.size) {
      for (
        let scope: LexicalEnvironment | undefined = preludeEnvironment();
        scope;
        scope = scope.parent
      )
        preludeFrames.add(scope)
    }
    const path: LexicalEnvironment[] = []
    let target = environment
    while (target && !target.variables.has(name) && !target.functions.has(name)) {
      path.push(target)
      target = target.parent
    }
    if (!target?.variables.has(name) || preludeFrames.has(originalFrame(target))) return undefined
    const variables = new Map(target.variables).set(name, value)
    let updated: LexicalEnvironment = { ...target, variables }
    originalFrames.set(updated, originalFrame(target))
    for (const frame of path.reverse()) {
      const copy = { ...frame, parent: updated }
      originalFrames.set(copy, originalFrame(frame))
      updated = copy
    }
    return updated
  }

  // The timeline reads shape annotations to recover prevailing state at a
  // clip's start beat, so restore local bindings in both the shape and visitor.
  const restoreBlockScope = (
    result: ScoreShapeEvaluationResult,
    inner: ScoreVisitor,
    outer: ScoreVisitor,
  ): ScoreShapeEvaluationResult => {
    const after = visitorAfter(result, inner)
    if (!hasShape(result)) return result
    if (after.scope.environment === outer.scope.environment) return withVisitor(result, after)
    const restored = changeVisitor(after, (context, base) => {
      const outerEnvironment = resolveContext(outer.scope.resolve, base).lexicalEnvironment
      let lexicalEnvironment = context.lexicalEnvironment
      if (outerEnvironment) {
        const expected = originalFrame(outerEnvironment)
        while (lexicalEnvironment && originalFrame(lexicalEnvironment) !== expected)
          lexicalEnvironment = lexicalEnvironment.parent
      }
      return {
        ...context,
        lexicalEnvironment: outerEnvironment && (lexicalEnvironment ?? outerEnvironment),
      }
    })
    const end = withVisitorContext(sequence([], []), restored)
    return withVisitor(
      { ...result, shape: sequence([result.shape, end], result.shape.origins) },
      restored,
    )
  }

  const visitLoopIteration = (
    body: Extract<Expression, { type: 'Sequence' }>,
    visitor: ScoreVisitor,
  ) => {
    const loop: LoopFrame = {}
    const result = visitBlock(body, visitor.spawn({ loop }))
    const after = visitorAfter(result, visitor).spawn({ loop: visitor.scope.loop })
    return { result: withVisitor(result, after), jump: loop.jump }
  }

  const visitLoopElse = (
    loop: Extract<Expression, { type: 'ForBlock' | 'WhileBlock' }>,
    result: ScoreShapeEvaluationResult,
    visitor: ScoreVisitor,
    broke: boolean,
  ): ScoreShapeEvaluationResult => {
    if (broke || !loop.alternate || !hasShape(result)) return result
    const after = at(
      visitorAfter(result, visitor),
      visitor.scope.offset.add(result.shape.duration.mul(visitor.scope.timeScale)),
    )
    const tail = restoreBlockScope(visitBlock(loop.alternate, after), after, after)
    const diagnostics = [...result.diagnostics, ...tail.diagnostics]
    if (!hasShape(tail)) return { diagnostics }
    return withVisitor(
      { shape: sequence([result.shape, tail.shape], [origin(loop)]), diagnostics },
      visitorAfter(tail, after),
    )
  }

  const evaluateNode: VisitorEvaluation<
    ScoreExpression,
    VisitorScope,
    ScoreShapeEvaluationResult
  > = (current, visitor) => {
    const {
      context,
      pulse: currentPulse,
      dynamic: currentDynamic,
      articulation: currentArticulation,
      articulationMarks: currentArticulationMarks,
      directiveState: currentDirectiveState,
      environment,
    } = visitor.scope
    if (current.type === 'BindingAssignment') {
      const evaluated = evaluateExpression(current.value, context, environment)
      if (!('value' in evaluated)) return evaluated
      const name = current.name.name
      const value = evaluated.value
      const updated = assignBinding(environment, name, value)
      if (!updated)
        return {
          diagnostics: [
            ...evaluated.diagnostics,
            {
              code: 'XP_ASSIGNMENT',
              severity: 'error',
              message: `Assignment requires an existing score variable named ${name}.`,
              locations: [current.name.location],
            },
          ],
        }
      const next = changeVisitor(visitor, (context) => ({
        ...context,
        lexicalEnvironment:
          context.lexicalEnvironment === environment
            ? updated
            : (assignBinding(context.lexicalEnvironment, name, value) ??
              context.lexicalEnvironment),
      }))
      return withVisitor(
        {
          shape: withVisitorContext(sequence([], [origin(current)]), next),
          diagnostics: evaluated.diagnostics,
        },
        next,
      )
    }
    if (current.type === 'LoopJump') {
      const loop = visitor.scope.loop
      if (!loop)
        return {
          diagnostics: [
            {
              code: 'XP_LOOP_JUMP',
              severity: 'error',
              message: `${current.action} requires an enclosing loop body in the same score scope.`,
              locations: [current.location],
            },
          ],
        }
      loop.jump = current.action
      return { shape: sequence([], [origin(current)]), diagnostics: [] }
    }
    if (current.type === 'IfBlock') {
      const condition = evaluateExpression(current.condition, context, environment)
      if (!('value' in condition)) return condition
      const branch = isTruthy(condition.value) ? current.consequent : current.alternate
      if (!branch)
        return { shape: sequence([], [origin(current)]), diagnostics: condition.diagnostics }
      const result =
        branch.type === 'Sequence'
          ? restoreBlockScope(visitBlock(branch, visitor), visitor, visitor)
          : visitor.visit(branch)
      return withVisitor(
        { ...result, diagnostics: [...condition.diagnostics, ...result.diagnostics] },
        visitorAfter(result, visitor),
      )
    }
    if (current.type === 'ThrowStatement')
      return { diagnostics: evaluateThrow(current, context, environment) }
    if (current.type === 'ReturnStatement')
      return {
        diagnostics: [
          {
            code: 'XP_RETURN_SCOPE',
            severity: 'error',
            message: 'ret requires an enclosing function body.',
            locations: [current.location],
          },
        ],
      }
    if (current.type === 'TryBlock') {
      const loop = visitor.scope.loop
      const trialLoop = loop && { ...loop }
      const scope = visitor.spawn({ loop: trialLoop, stopOnError: true })
      const trial = visitBlock(current.body, scope, true)
      if (hasShape(trial)) {
        if (loop) loop.jump = trialLoop?.jump
        const completed = restoreBlockScope(trial, scope, visitor)
        return withVisitor(
          completed,
          visitorAfter(completed, visitor).spawn({ loop, stopOnError: visitor.scope.stopOnError }),
        )
      }
      const failure = catchableDiagnostic(trial.diagnostics)
      if (!failure) return trial
      const name = current.name
      const handler = name
        ? changeVisitor(visitor, (context) => ({
            ...context,
            lexicalEnvironment: extendLexicalEnvironment(
              context.lexicalEnvironment ?? preludeEnvironment(),
              {
                variables: new Map([[name.name, stringValue(failure.message, [origin(name)])]]),
              },
            ),
          }))
        : visitor
      return restoreBlockScope(visitBlock(current.handler, handler), handler, visitor)
    }
    if (current.type === 'ForBlock') {
      const iterable = evaluateExpression(current.iterable, context, environment)
      if (!('value' in iterable)) return iterable
      const diagnostics = [...iterable.diagnostics]
      if (iterable.value.kind !== 'container') {
        return {
          diagnostics: [
            ...diagnostics,
            {
              code: 'XP_NOT_ITERABLE',
              severity: 'error',
              message: `for ${current.mode} requires a container.`,
              locations: [current.iterable.location],
            },
          ],
        }
      }
      const { values } = iterable.value
      let active = visitor
      let elapsed = new Fraction(0)
      const shapes: ScoreShape[] = []
      let broke = false
      for (let index = 0; index < values.length; index++) {
        active = at(active, visitor.scope.offset.add(elapsed.mul(visitor.scope.timeScale)))
        const value =
          current.mode === 'in'
            ? {
                kind: 'scalar' as const,
                value: new Value(index),
                origins: [origin(current.name)],
              }
            : values[index]!
        const inner = changeVisitor(active, (context) => ({
          ...context,
          lexicalEnvironment: extendLexicalEnvironment(
            context.lexicalEnvironment ?? preludeEnvironment(),
            { variables: new Map([[current.name.name, value]]) },
          ),
        }))
        const { result, jump } = visitLoopIteration(current.body, inner)
        const iteration = restoreBlockScope(result, inner, active)
        diagnostics.push(...iteration.diagnostics)
        if (!hasShape(iteration)) return { diagnostics }
        const binding = withVisitorContext(sequence([], []), inner)
        shapes.push(sequence([binding, iteration.shape], iteration.shape.origins))
        elapsed = elapsed.add(iteration.shape.duration)
        active = visitorAfter(iteration, active)
        if (jump === 'break') {
          broke = true
          break
        }
      }
      const result = withVisitor(
        { shape: sequence(shapes, [origin(current)]), diagnostics },
        active,
      )
      return visitLoopElse(current, result, visitor, broke)
    }
    if (current.type === 'WhileBlock') {
      const diagnostics: Diagnostic[] = []
      const shapes: ScoreShape[] = []
      let broke = false
      let active = visitor
      let elapsed = new Fraction(0)
      for (;;) {
        active = at(active, visitor.scope.offset.add(elapsed.mul(visitor.scope.timeScale)))
        const condition = evaluateExpression(
          current.condition,
          active.scope.context,
          active.scope.environment,
        )
        diagnostics.push(...condition.diagnostics)
        if (!('value' in condition)) return { diagnostics }
        if (!isTruthy(condition.value)) break
        const { result: iteration, jump } = visitLoopIteration(current.body, active)
        diagnostics.push(...iteration.diagnostics)
        if (!hasShape(iteration)) return { diagnostics }
        shapes.push(iteration.shape)
        elapsed = elapsed.add(iteration.shape.duration)
        active = visitorAfter(iteration, active)
        if (jump === 'break') {
          broke = true
          break
        }
      }
      const result = restoreBlockScope(
        { shape: sequence(shapes, [origin(current)]), diagnostics },
        active,
        visitor,
      )
      return visitLoopElse(current, result, visitor, broke)
    }
    if (current.type === 'BinaryExpression' && current.operator === '->') {
      const directiveOnly = (expression: Expression): boolean =>
        expression.type === 'Directive' ||
        (expression.type === 'Group' && directiveOnly(expression.expression))
      const invalidOperand = (
        expression: Expression,
        diagnostics: readonly Diagnostic[] = [],
      ): ScoreShapeEvaluationResult => ({
        diagnostics: [
          ...diagnostics,
          {
            code: 'XP_TIE_OPERAND',
            severity: 'error',
            message: 'A tie operand must contain at least one note.',
            locations: [expression.location],
          },
        ],
      })
      if (directiveOnly(current.left)) return invalidOperand(current.left)
      const left = visitor.visit(current.left)
      if (!hasShape(left) || visitor.scope.loop?.jump) return left
      if (!attacks(left.shape).length) return invalidOperand(current.left, left.diagnostics)
      if (directiveOnly(current.right)) return invalidOperand(current.right, left.diagnostics)
      const next = at(
        visitorAfter(left, visitor),
        visitor.scope.offset.add(left.shape.duration.mul(visitor.scope.timeScale)),
      )
      const right = next.visit(current.right)
      const diagnostics = [...left.diagnostics, ...right.diagnostics]
      if (!hasShape(right)) return { diagnostics }
      if (visitor.scope.loop?.jump)
        return withVisitor(
          { shape: sequence([left.shape, right.shape], [origin(current)]), diagnostics },
          visitorAfter(right, next),
        )
      if (!attacks(right.shape).length) return invalidOperand(current.right, diagnostics)
      return withVisitor(
        {
          shape: tieScoreShapes(left.shape, right.shape, [origin(current, 'operator')]),
          diagnostics,
        },
        visitorAfter(right, next),
      )
    }
    if (current.type === 'DrumSampleLiteral') {
      return visitor.visit({
        type: 'DegreeLiteral',
        degree: '0',
        modifiers: [],
        raw: current.sample,
        location: current.location,
      })
    }
    if (current.type === 'CallExpression') {
      const returned = evaluateFunctionCall(
        current,
        context,
        environment,
        (expression, scope, protectedReturn) =>
          changeVisitor(visitor, (context) => ({
            ...context,
            lexicalEnvironment: scope,
          })).visit(expression, {
            loop: undefined,
            stopOnError: protectedReturn || visitor.scope.stopOnError,
            subdivisionContext: visitor.scope.resolve,
          }),
      )
      if (returned) {
        if (!hasShape(returned)) return returned
        return {
          ...returned,
          shape: {
            ...annotateScoreUse(returned.shape, origin(current)),
            isolatedDirectiveScope: true,
          },
        }
      }
    }
    const broadcast = broadcastScalarOperation(current, context, environment)
    if (broadcast) return visitor.visit(broadcast)
    const expandedChord = expandEnumeratedChord(current, context, environment)
    if (expandedChord.diagnostics.length) return { diagnostics: expandedChord.diagnostics }
    if (expandedChord.expressions.length !== 1 || expandedChord.expressions[0] !== current) {
      const results = expandedChord.expressions.map((expression) => visitor.visit(expression))
      const diagnostics = results.flatMap((result) => result.diagnostics)
      if (!results.every(hasShape)) return { diagnostics }
      const branches = results.map((result) => result.shape)
      const duration = branches.reduce(
        (maximum, branch) => (branch.duration.compare(maximum) > 0 ? branch.duration : maximum),
        new Fraction(0),
      )
      return {
        shape: {
          kind: 'parallel',
          duration,
          branches: branches.map((branch) => pad(branch, duration)),
          origins: [origin(current)],
        },
        diagnostics,
      }
    }
    if (current.type === 'Rest') {
      return {
        shape: {
          kind: 'rest',
          duration: currentPulse.mul(current.raw.length),
          generated: false,
          origins: [origin(current)],
        },
        diagnostics: [],
      }
    }
    if (current.type === 'BarRest') {
      const signature = visitor.scope.timeSignature
      const measure = signature
        ? {
            length: new Fraction(signature.numerator * 4, signature.denominator),
            origin: signature.origin,
          }
        : inheritedMeasureAt(visitor.scope.offset)
      const duration = measure
        ? measure.length
            .sub(visitor.scope.offset.sub(measure.origin).mmod(measure.length))
            .div(visitor.scope.timeScale)
        : new Fraction(0)
      return {
        shape: { kind: 'rest', duration, generated: false, origins: [origin(current, 'duration')] },
        diagnostics: measure
          ? []
          : [
              {
                code: 'XP_BAR_REST_WITHOUT_TIME_SIGNATURE',
                severity: 'warning',
                message: 'A bar rest has no effect without a prevailing time signature.',
                locations: [current.location],
              },
            ],
      }
    }
    if (current.type === 'DetachedContinue') {
      const shape: ContinueShape = {
        kind: 'continue',
        duration: currentPulse,
        origins: [origin(current, 'duration')],
      }
      return { shape, diagnostics: [] }
    }
    if (current.type === 'Barline' || current.type === 'HardBoundary') {
      const signature = visitor.scope.timeSignature
      const measure = signature
        ? {
            length: new Fraction(signature.numerator * 4, signature.denominator),
            origin: signature.origin,
          }
        : inheritedMeasureAt(visitor.scope.offset)
      const offCycle =
        !visitor.scope.layout &&
        measure &&
        visitor.scope.offset.sub(measure.origin).div(measure.length).d !== 1
      return {
        shape: withOccurrence(
          barline(current, current.type === 'Barline' ? 'single' : 'double'),
          visitor,
        ),
        diagnostics: offCycle
          ? [
              {
                code: 'XP_BARLINE_OFF_CYCLE',
                severity: 'warning',
                message: `Barline does not fall on a whole multiple of the ${measure.length.toFraction()}-beat measure.`,
                locations: [current.location],
              },
            ]
          : [],
      }
    }
    if (current.type === 'Repeat') {
      if (playback) {
        // Loops defer repeat expansion until execution reaches the repeat.
        return visitBlock(
          { type: 'Sequence', items: [current], location: current.location },
          visitor,
          false,
          visitor.scope.declarationScope,
        )
      }
      const count = repeatCount(current)
      if (count === undefined) {
        return {
          diagnostics: [
            {
              code: 'XP_REPEAT_COUNT',
              severity: 'error',
              message: `Repeat count must be an exact non-negative integer within the ${MAX_REPEAT_EXPANSION_NODES}-node expansion limit.`,
              locations: [current.count?.location ?? current.location],
            },
          ],
        }
      }
      let activeVisitor = visitor
      let displayedShapes: ScoreShape[] | undefined
      let displayedAttacks: AttackShape[] = []
      const alternatives: AttackAppearance[][] = []
      const traversed: ScoreShape[] | undefined = visitor.scope.loop ? [] : undefined
      const diagnostics: Diagnostic[] = []
      // Evaluate the written body once even for x0 so it remains engravable between the markers.
      const iterations = Math.max(1, count)
      for (let iteration = 0; iteration < iterations; iteration++) {
        if (iteration > 0 && current.replayPrefix?.length) spendFlowBudget(current)
        const iterationNode: Expression = {
          type: 'Sequence',
          items: [...repeatBody(current, iteration)],
          location: current.location,
        }
        const result = activeVisitor.visit(
          iterationNode,
          !count && visitor.scope.loop ? { loop: {} } : {},
        )
        const nextVisitor = visitorAfter(result, activeVisitor)
        diagnostics.push(...result.diagnostics)
        if (!hasShape(result)) return { diagnostics }
        const iterationShapes = [result.shape]
        traversed?.push(result.shape)
        if (!displayedShapes) {
          displayedShapes = iterationShapes
          displayedAttacks = iterationShapes.flatMap(attacks)
          for (const _attack of displayedAttacks) alternatives.push([])
        } else {
          const iterationAttacks = iterationShapes.flatMap(attacks)
          for (
            let index = 0;
            index < Math.min(displayedAttacks.length, iterationAttacks.length);
            index++
          ) {
            const attack = iterationAttacks[index]!
            alternatives[index]!.push({
              pitch: attack.pitch,
              rootPitch: attack.rootPitch,
            })
          }
        }
        if (visitor.scope.loop?.jump)
          return withVisitor(
            { shape: sequence(traversed ?? iterationShapes, [origin(current)]), diagnostics },
            nextVisitor,
          )
        if (iteration < count) activeVisitor = nextVisitor
      }
      const displayed = annotateRepeatAppearances(
        sequence(displayedShapes ?? [], [origin(current)]),
        alternatives,
      ) as SequenceShape
      const commonNode: Expression = {
        type: 'Sequence',
        items: current.body,
        location: current.location,
      }
      const engravingLoop = visitor.scope.loop ? {} : undefined
      const commonResult = visitor.visit(commonNode, { loop: engravingLoop })
      const endingVisitor = visitorAfter(commonResult, visitor)
      diagnostics.push(...commonResult.diagnostics)
      const commonShapes = hasShape(commonResult) ? [commonResult.shape] : []
      const endingShapes = current.endings.map((ending) => {
        const endingNode: Expression = {
          type: 'Sequence',
          items: ending.body,
          location: current.location,
        }
        const result = endingVisitor.visit(endingNode, {
          loop: visitor.scope.loop ? {} : undefined,
        })
        diagnostics.push(...result.diagnostics)
        return hasShape(result) ? [result.shape] : []
      })
      const endingMarkers = current.endings.flatMap((ending, index): ScoreShape[] => [
        endingMarker(current, ending, index),
        ...endingShapes[index]!,
        index === current.endings.length - 1
          ? repeatMarker(current, 'end', 'ending-end')
          : endingMarker(current, current.endings[index + 1]!, index + 1, 'repeat-end'),
      ])
      return withVisitor(
        {
          shape: sequence(
            [
              repeatMarker(current, 'start', 'repeat-start'),
              ...(current.endings.length
                ? [...commonShapes, ...endingMarkers]
                : displayed.children),
              ...(current.endings.length ? [] : [repeatMarker(current, 'end', 'repeat-end')]),
            ],
            [origin(current)],
          ),
          diagnostics,
        },
        activeVisitor,
      )
    }
    if (current.type === 'Sequence' || current.type === 'RepeatChain') {
      let activeVisitor = visitor
      let elapsed = new Fraction(0)
      let velocity: Fraction | undefined
      let grace: { duration: Fraction; count: number; indices: number[] } | undefined
      let ramp:
        | { curve: string; nextCurve?: string; source?: ScoreShape['directiveRampStart'] }
        | undefined
      let gliss:
        | {
            indices: number[]
            /** A chained gliss reuses the previous target after it became a continuation. */
            sourceShape?: ScoreShape
            chainRequested?: boolean
            ownerIndex?: number
            segmentStart?: Fraction
            curve: string
            nextCurve?: string
          }
        | undefined
      const results: ScoreShapeEvaluationResult[] = []
      const loop = visitor.scope.loop
      let checkedResults = 0
      const interrupted = () => {
        if (loop?.jump) return true
        if (!visitor.scope.stopOnError) return false
        while (checkedResults < results.length) {
          if (results[checkedResults++]!.diagnostics.some(({ severity }) => severity === 'error'))
            return true
        }
        return false
      }
      const sequenceItems = function* (): Generator<ScoreExpression> {
        for (const item of current.type === 'Sequence' ? current.items : [current]) {
          if (item.type === 'RepeatChain') yield* resolveRepeatChain(item.repeats)
          else yield item
        }
      }
      // Expand a reached repeat in place so one-shot directives can see its
      // items and a jump can still leave later repeats unexpanded.
      const items = function* (): Generator<ScoreExpression> {
        for (const item of sequenceItems()) {
          if (interrupted()) return
          if (playback && item.type === 'Repeat') {
            const expanded = expandBlockRepeats(
              { type: 'Sequence', items: [item], location: item.location },
              false,
              item.expansionPath ?? visitor.scope.expansionPath,
            )
            if (expanded.diagnostics.length) {
              results.push(
                expanded.program
                  ? { shape: sequence([], []), diagnostics: expanded.diagnostics }
                  : { diagnostics: expanded.diagnostics },
              )
            }
            if (!expanded.program) return
            for (const child of expanded.program.body) {
              if (interrupted()) return
              yield child
            }
          } else yield item
        }
      }
      for (const item of items()) {
        activeVisitor = at(
          activeVisitor,
          visitor.scope.offset.add(elapsed.mul(visitor.scope.timeScale)),
          item.expansionPath ?? visitor.scope.expansionPath,
        )
        if (item.type === 'VariableDeclaration' || item.type === 'FunctionDeclaration') {
          const declared = evaluateDeclaration(
            item,
            activeVisitor.scope.context,
            activeVisitor.scope.environment,
            activeVisitor.scope.declarationScope,
          )
          if (declared.diagnostics.some(({ severity }) => severity === 'error')) {
            results.push({ diagnostics: declared.diagnostics })
            continue
          }
          activeVisitor = changeVisitor(activeVisitor, (context) => ({
            ...context,
            lexicalEnvironment: extendLexicalEnvironment(
              context.lexicalEnvironment ?? preludeEnvironment(),
              {
                variables: declared.environment.variables,
                functions: declared.environment.functions,
              },
            ),
          }))
          results.push({
            shape: withVisitorContext(sequence([], [origin(item)]), activeVisitor),
            diagnostics: declared.diagnostics,
          })
          continue
        }
        if (item.type === 'PitchContextChange') {
          try {
            const previousContext = activeVisitor.scope.context
            const changedContext = applyPitchContextChange(
              item,
              previousContext,
              activeVisitor.scope.environment,
            )
            activeVisitor = changeVisitor(activeVisitor, (context) => ({
              ...context,
              pitchContext: applyPitchContextChange(
                item,
                context.pitchContext,
                context.lexicalEnvironment,
              ),
            }))
            results.push({
              shape: withVisitorContext(
                contextShape(item, changedContext, previousContext),
                activeVisitor,
              ),
              diagnostics: [],
            })
          } catch (error) {
            results.push({
              diagnostics:
                error instanceof EvaluationError
                  ? error.diagnostics
                  : [
                      {
                        code: 'XP_CONTEXT',
                        severity: 'error',
                        message: error instanceof Error ? error.message : 'Invalid pitch context.',
                        locations: [item.location],
                      },
                    ],
            })
          }
          continue
        }
        if (item.type === 'Directive') {
          const extended = applyExtension(
            item,
            activeVisitor.scope.context,
            activeVisitor.scope.directiveState,
          )
          if (extended) {
            activeVisitor = changeVisitor(activeVisitor, (context) => {
              const applied = applyExtension(item, context.pitchContext, context.directiveState)!
              if (applied.diagnostics.some(({ severity }) => severity === 'error'))
                throw new EvaluationError(applied.diagnostics)
              return { ...context, directiveState: applied.state }
            })
            let shape = withVisitorContext(sequence([], [origin(item, 'directive')]), activeVisitor)
            if (ramp && !extended.diagnostics.some(({ severity }) => severity === 'error')) {
              const extension = extensions.get(item.name)!
              const stateKey = extension.stateKey?.toLowerCase() ?? item.name
              if (!ramp.source) {
                ramp.source = { curve: ramp.curve, stateKey, directiveName: item.name }
                shape = { ...shape, directiveRampStart: ramp.source }
              } else if (
                ramp.source.stateKey === stateKey &&
                ramp.source.directiveName === item.name
              ) {
                shape = { ...shape, directiveRampEnd: ramp.source }
                if (ramp.nextCurve) {
                  ramp = {
                    curve: ramp.nextCurve,
                    source: { curve: ramp.nextCurve, stateKey, directiveName: item.name },
                  }
                  shape = { ...shape, directiveRampStart: ramp.source }
                } else ramp = undefined
              }
            }
            results.push({ shape, diagnostics: extended.diagnostics })
            continue
          }
          const resolved = resolveDirective(
            item,
            activeVisitor.scope.context,
            activeVisitor.scope.environment,
          )
          const directive = resolved.directive
          if (directive?.kind === 'tempo' && !options.allowTempoDirective) {
            resolved.diagnostics.push({
              code: 'XP_TEMPO_SCOPE',
              severity: 'error',
              message: '@tempo is only allowed in a global source.',
              locations: [item.location],
            })
          }
          if (directive?.kind === 'subdivision')
            activeVisitor = changeVisitor(activeVisitor, (context, base) => ({
              ...context,
              pulse: resolveContext(visitor.scope.subdivisionContext, base).pulse.mul(
                directive.pulse,
              ),
            }))
          else if (directive?.kind === 'dynamic')
            activeVisitor = changeVisitor(activeVisitor, (context) => ({
              ...context,
              dynamic: directive.mark,
            }))
          else if (directive?.kind === 'time') {
            const signature = {
              numerator: directive.numerator,
              denominator: directive.denominator,
              origin: activeVisitor.scope.offset,
            }
            activeVisitor = changeVisitor(activeVisitor, (context) => ({
              ...context,
              timeSignature: signature,
            }))
          } else if (directive?.kind === 'tempo')
            activeVisitor = changeVisitor(activeVisitor, (context) => ({
              ...context,
              tempo: directive.bpm,
            }))
          else if (directive?.kind === 'velocity') velocity = directive.velocity
          else if (directive?.kind === 'grace')
            grace = { duration: directive.duration, count: directive.count, indices: [] }
          else if (directive?.kind === 'ramp') {
            if (!ramp) ramp = { curve: directive.curve }
            else if (ramp.source) ramp.nextCurve = directive.curve
          } else if (directive?.kind === 'gliss') {
            // A gliss directive between the source and target starts another segment at that
            // target. Keep collecting the current pair; completion below will seed the next pair.
            if (!gliss) gliss = { indices: [], curve: directive.curve }
            else if (gliss.indices.length === 1) {
              gliss.chainRequested = true
              gliss.nextCurve = directive.curve
            }
          } else if (directive?.kind === 'articulation') {
            const articulationMarks =
              directive.shorthand && directive.mark !== '-'
                ? [...activeVisitor.scope.articulationMarks, directive.mark!]
                : []
            activeVisitor = changeVisitor(activeVisitor, (context) => ({
              ...context,
              articulation: directive.ratio,
              articulationMarks,
            }))
          }
          let grooveTemplate: ScoreShape | undefined
          if (directive?.kind === 'groove' && directive.argument) {
            const template = activeVisitor.visit(directive.argument, {
              loop: undefined,
              dynamic: 'mf',
              articulation: new Fraction(1),
              articulationMarks: [],
              directiveState: initialDirectiveState,

              subdivisionContext: activeVisitor.scope.resolve,
            })
            resolved.diagnostics.push(...template.diagnostics)
            if ('shape' in template) {
              if (attacks(template.shape).length < 2 || template.shape.duration.compare(0) <= 0) {
                resolved.diagnostics.push({
                  code: 'XP_GROOVE',
                  severity: 'error',
                  message: 'A groove requires at least two notes over a positive duration.',
                  locations: [directive.argument.location],
                })
              } else grooveTemplate = template.shape
            }
          }
          let droneTemplate: ScoreShape | undefined
          if (directive?.kind === 'drone' && directive.argument) {
            const template = activeVisitor.visit(directive.argument, {
              loop: undefined,
              subdivisionContext: activeVisitor.scope.resolve,
            })
            resolved.diagnostics.push(...template.diagnostics)
            if ('shape' in template) {
              if (!attacks(template.shape).length) {
                resolved.diagnostics.push({
                  code: 'XP_DRONE',
                  severity: 'error',
                  message: 'A drone expression must contain at least one note.',
                  locations: [directive.argument.location],
                })
              } else droneTemplate = template.shape
            }
          }
          const shape: ScoreShape =
            directive?.kind === 'unknown'
              ? {
                  kind: 'annotation',
                  text: item.rawName.startsWith('@') ? item.rawName : `@${item.rawName}`,
                  duration: new Fraction(0),
                  origins: [origin(item, 'directive')],
                }
              : directive?.kind === 'dynamic'
                ? {
                    kind: 'dynamic',
                    mark: directive.mark,
                    duration: new Fraction(0),
                    origins: [origin(item, 'directive')],
                  }
                : directive?.kind === 'groove'
                  ? {
                      kind: 'groove',
                      template: grooveTemplate,
                      controlCount: grooveTemplate ? attacks(grooveTemplate).length : undefined,
                      duration: new Fraction(0),
                      origins: [origin(item, 'directive')],
                    }
                  : directive?.kind === 'drone'
                    ? {
                        kind: 'drone',
                        template: droneTemplate,
                        duration: new Fraction(0),
                        origins: [origin(item, 'directive')],
                      }
                    : directive?.kind === 'clef'
                      ? {
                          kind: 'clef',
                          clef: directive.clef,
                          duration: new Fraction(0),
                          origins: [origin(item, 'directive')],
                        }
                      : directive?.kind === 'time'
                        ? {
                            kind: 'time-signature',
                            numerator: directive.numerator,
                            denominator: directive.denominator,
                            duration: new Fraction(0),
                            origins: [origin(item, 'directive')],
                          }
                        : directive?.kind === 'tempo' && options.allowTempoDirective
                          ? {
                              kind: 'tempo',
                              bpm: directive.bpm,
                              duration: new Fraction(0),
                              origins: [origin(item, 'directive')],
                            }
                          : sequence([], [origin(item, 'directive')])
          results.push({
            shape:
              directive?.kind === 'subdivision' ||
              directive?.kind === 'dynamic' ||
              directive?.kind === 'articulation' ||
              directive?.kind === 'time' ||
              directive?.kind === 'tempo'
                ? withVisitorContext(shape, activeVisitor)
                : withOccurrence(shape, activeVisitor),
            diagnostics: resolved.diagnostics,
          })
          continue
        }
        let result = activeVisitor.visit(item)
        const index = results.length
        if ('shape' in result && attacks(result.shape).length) {
          if (velocity) {
            let first = true
            const pending = velocity
            const applyVelocity = (shape: ScoreShape): ScoreShape => {
              if (shape.kind === 'attack' && first) {
                first = false
                return {
                  ...shape,
                  velocity: pending,
                  velocityExplicit: true,
                } as PlaybackAttackShape
              }
              if (shape.kind === 'sequence')
                return { ...shape, children: shape.children.map(applyVelocity) }
              if (shape.kind === 'parallel')
                return { ...shape, branches: shape.branches.map(applyVelocity) }
              return shape
            }
            result = { ...result, shape: applyVelocity(result.shape) }
            velocity = undefined
          }
          if (grace) grace.indices.push(index)
          if (gliss) gliss.indices.push(index)
        }
        results.push(result)
        // A chained gliss uses the previous target as the source of its next segment. Keep
        // detached continuations in that source span just as attached postfix continuations
        // already are. Barlines can separate the target and continuation, so this cannot be
        // derived solely from the target expression when the chain is first established.
        if (
          (item.type === 'DetachedContinue' ||
            (item.type === 'PostfixExpression' &&
              (item.expression.type === 'DetachedContinue' ||
                item.expression.type === 'Barline'))) &&
          gliss?.sourceShape &&
          gliss.indices.length === 1 &&
          'shape' in result
        )
          gliss.sourceShape = sequence([gliss.sourceShape, result.shape], gliss.sourceShape.origins)
        if (grace && grace.indices.length === grace.count + 1) {
          const targetIndex = grace.indices[grace.indices.length - 1]!
          const stolen = grace.duration.mul(grace.count)
          for (const i of grace.indices.slice(0, -1)) {
            const r = results[i]!
            if ('shape' in r) {
              elapsed = elapsed.add(grace.duration.sub(r.shape.duration))
              results[i] = {
                ...r,
                shape: mapAttacks(resizeShape(r.shape, grace.duration), (attack) => ({
                  ...attack,
                  grace: true,
                })),
              }
            }
          }
          const target = results[targetIndex]!
          if ('shape' in target && target.shape.duration.compare(stolen) >= 0) {
            const notatedDuration = target.shape.duration
            results[targetIndex] = {
              ...target,
              shape: mapAttacks(
                trimShape(target.shape, target.shape.duration.sub(stolen)),
                (attack) => ({ ...attack, notatedDuration }),
              ),
            }
          } else
            results.push({
              diagnostics: [
                {
                  code: 'XP_GRACE_DURATION',
                  severity: 'error',
                  message: 'Grace notes exceed the following item duration.',
                  locations: [item.location],
                },
              ],
            })
          grace = undefined
        }
        if (gliss && gliss.indices.length === 2) {
          const sourceIndex = gliss.indices[0]!,
            targetIndex = gliss.indices[1]!,
            source = results[sourceIndex]!,
            target = results[targetIndex]!
          const sourceShape = gliss.sourceShape ?? ('shape' in source ? source.shape : undefined)
          if (sourceShape && 'shape' in target) {
            const to = attacks(target.shape)
            const sourceTree = pitchTree(sourceShape)
            const targetTree = pitchTree(target.shape)
            const { diagnostics: continuationDiagnostics } = layoutNotes(target.shape)
            if (continuationDiagnostics.length)
              results[targetIndex] = {
                diagnostics: [...target.diagnostics, ...continuationDiagnostics],
              }
            else if (!sourceTree || !targetTree || !matchingPitchTrees(sourceTree, targetTree))
              results.push({
                diagnostics: [
                  {
                    code: 'XP_GLISS_SHAPE',
                    severity: 'error',
                    message: 'Glissando source and target pitch structures must match.',
                    locations: [item.location],
                  },
                ],
              })
            else {
              const curve = gliss.curve
              const spans = attackSpans(sourceShape)
              const sourceAttacks = attacks(sourceShape)
              let leaf = 0
              const automate = (shape: ScoreShape): ScoreShape => {
                if (shape.kind === 'attack') {
                  const destination = to[leaf++]!
                  const duration = spans.get(shape) ?? shape.duration
                  return {
                    ...shape,
                    automation: {
                      curve,
                      from: shape.pitch,
                      to: destination.pitch,
                      fromRootPitch: shape.rootPitch,
                      toRootPitch: destination.rootPitch,
                      duration,
                      segments: [
                        {
                          curve,
                          from: shape.pitch,
                          to: destination.pitch,
                          fromRootPitch: shape.rootPitch,
                          toRootPitch: destination.rootPitch,
                          start: new Fraction(0),
                          duration,
                        },
                      ],
                    },
                  }
                }
                if (shape.kind === 'sequence')
                  return { ...shape, children: shape.children.map(automate) }
                if (shape.kind === 'parallel')
                  return { ...shape, branches: shape.branches.map(automate) }
                return shape
              }
              // Only the first segment owns an attack. Later segments begin at a target which
              // has already been lowered to a continuation of that original attack.
              if (!gliss.sourceShape && 'shape' in source)
                results[sourceIndex] = { ...source, shape: automate(sourceShape) }
              else if (gliss.ownerIndex !== undefined) {
                const owner = results[gliss.ownerIndex]!
                const segmentStart = gliss.segmentStart
                let attackIndex = 0
                if ('shape' in owner)
                  results[gliss.ownerIndex] = {
                    ...owner,
                    shape: mapAttacks(owner.shape, (attack) => {
                      const segmentSource = sourceAttacks[attackIndex]!
                      const destination = to[attackIndex++]!
                      const duration = spans.get(segmentSource) ?? segmentSource.duration
                      const previous = attack.automation
                      return {
                        ...attack,
                        automation: previous && {
                          ...previous,
                          segments: [
                            ...(previous.segments ?? []),
                            {
                              curve,
                              from: segmentSource.pitch,
                              to: destination.pitch,
                              fromRootPitch: segmentSource.rootPitch,
                              toRootPitch: destination.rootPitch,
                              start: segmentStart ?? previous.duration,
                              duration,
                            },
                          ],
                        },
                      }
                    }),
                  }
              }
              const chainedSource = target.shape
              results[targetIndex] = target.shape.duration.n
                ? {
                    ...target,
                    shape: {
                      kind: 'continue',
                      duration: target.shape.duration,
                      origins: target.shape.origins,
                      extendsAutomation: false,
                    },
                  }
                : { ...target, shape: sequence([], target.shape.origins) }
              gliss = gliss.chainRequested
                ? {
                    indices: [targetIndex],
                    sourceShape: chainedSource,
                    ownerIndex: gliss.ownerIndex ?? sourceIndex,
                    segmentStart: (gliss.segmentStart ?? new Fraction(0)).add(sourceShape.duration),
                    curve: gliss.nextCurve ?? 'linear',
                  }
                : undefined
            }
          }
          if (gliss?.indices.length === 2) gliss = undefined
        }
        const timed = results[index]!
        if ('shape' in timed) elapsed = elapsed.add(timed.shape.duration)
        activeVisitor = visitorAfter(result, activeVisitor)
      }
      const diagnostics = results.flatMap((result) => result.diagnostics)
      if (ramp)
        diagnostics.push({
          code: 'XP_DIRECTIVE',
          severity: 'error',
          message: '@ramp is missing required following signal directives.',
          locations: [current.location],
        })
      if (grace || gliss)
        diagnostics.push({
          code: 'XP_DIRECTIVE',
          severity: 'error',
          message: 'A one-shot directive is missing required following attacks.',
          locations: [current.location],
        })
      if (!results.every(hasShape)) return { diagnostics }
      return withVisitor(
        {
          shape: sequence(
            results.map((result) => result.shape),
            [origin(current)],
          ),
          diagnostics,
        },
        activeVisitor,
      )
    }
    if (current.type === 'Parallel') {
      const results = current.branches.map((branch) =>
        visitor.visit(branch, {
          loop: undefined,
          subdivisionContext: visitor.scope.resolve,
          declarationScope: {},
        }),
      )
      const diagnostics = results.flatMap((result) => result.diagnostics)
      if (!results.every(hasShape)) return { diagnostics }
      const branches = results.map((result) => result.shape)
      const duration = branches.reduce(
        (maximum, branch) => (branch.duration.compare(maximum) > 0 ? branch.duration : maximum),
        new Fraction(0),
      )
      const shape: ParallelShape = {
        kind: 'parallel',
        duration,
        branches: branches.map((branch) => pad(branch, duration)),
        origins: [origin(current)],
      }
      return { shape, diagnostics }
    }
    if (current.type === 'Group') {
      const grouped = visitor.visit(current.expression, {
        subdivisionContext: visitor.scope.resolve,
        declarationScope: {},
      })
      if (!('shape' in grouped)) return grouped
      return {
        ...grouped,
        shape: { ...grouped.shape, isolatedDirectiveScope: true },
      }
    }
    if (current.type === 'NormalizeToSlot') {
      if (!current.expression) {
        return {
          shape: {
            kind: 'rest',
            duration: currentPulse,
            generated: false,
            origins: [origin(current)],
          },
          diagnostics: [],
        }
      }
      const local = {
        loop: undefined,
        subdivisionContext: visitor.scope.resolve,
        declarationScope: {},
      }
      let evaluated = visitor.visit(current.expression, { ...local, layout: true })
      if (!('shape' in evaluated)) return evaluated
      if (!evaluated.shape.duration.n) {
        return {
          diagnostics: [
            ...evaluated.diagnostics,
            {
              code: 'XP_NORMALIZE_ZERO',
              severity: 'error',
              message: 'A non-empty zero-duration fragment cannot be normalized.',
              locations: [current.location],
            },
          ],
        }
      }
      if (!visitor.scope.layout) {
        const tried = new Set<string>()
        for (;;) {
          const duration = evaluated.shape.duration
          if (!duration.n || tried.has(duration.toFraction()) || tried.size >= 32)
            return {
              diagnostics: [
                {
                  code: 'XP_TIMELINE_LAYOUT',
                  severity: 'error',
                  message:
                    'Timed context changes do not produce a stable rhythm inside this normalized slot.',
                  locations: [current.location],
                },
              ],
            }
          tried.add(duration.toFraction())
          evaluated = visitor.visit(current.expression, {
            ...local,
            lockedPulse: visitor.scope.base.pulse,
            timeScale: visitor.scope.timeScale.mul(currentPulse).div(duration),
          })
          if (!('shape' in evaluated)) return evaluated
          if (evaluated.shape.duration.equals(duration)) break
        }
      }
      const normalizedSlots = evaluated.shape.duration.div(currentPulse)
      const normalized = scaleShape(evaluated.shape, currentPulse.div(evaluated.shape.duration))
      const tuplet = Number(normalizedSlots.d) === 1 ? Number(normalizedSlots.n) : undefined
      if (
        normalized.kind === 'sequence' &&
        tuplet &&
        tuplet > 1 &&
        !Number.isInteger(Math.log2(tuplet))
      ) {
        return {
          shape: { ...normalized, normalized: true, isolatedDirectiveScope: true, tuplet },
          diagnostics: evaluated.diagnostics,
        }
      }
      return {
        shape:
          normalized.kind === 'sequence' || normalized.kind === 'parallel'
            ? { ...normalized, normalized: true, isolatedDirectiveScope: true }
            : { ...normalized, isolatedDirectiveScope: true },
        diagnostics: evaluated.diagnostics,
      }
    }
    if (current.type === 'PostfixExpression') {
      const holdIndex = current.marks.findIndex((mark) => mark.type === 'HoldUntilEnd')
      if (holdIndex >= 0) {
        const prefix = current.marks.slice(0, holdIndex)
        const withoutHold = current.marks.filter((mark) => mark.type !== 'HoldUntilEnd')
        const heldFrom = current.marks.slice(holdIndex)
        const evaluated = visitor.visit(
          prefix.length ? { ...current, marks: prefix } : current.expression,
        )
        if (!('shape' in evaluated) || visitor.scope.loop?.jump) return evaluated
        const continuations = heldFrom.filter((mark) => mark.type === 'DetachedContinue')
        const extension = currentPulse.mul(continuations.length)
        const base = materializeScoreContinuations(evaluated.shape)
        const held = holdAttacks(
          base,
          base.duration.add(extension),
          extension,
          current.marks.map((mark) => origin(mark, 'duration')),
        )
        if (held)
          return withVisitor(
            { shape: held, diagnostics: evaluated.diagnostics },
            visitorAfter(evaluated, visitor),
          )
        return visitor.visit(
          withoutHold.length ? { ...current, marks: withoutHold } : current.expression,
        )
      }
      const continuations = current.marks.filter((mark) => mark.type === 'DetachedContinue')
      const elimination = current.marks.find((mark) => mark.type === 'TailElimination')
      let evaluated = visitor.visit(current.expression)
      if (!('shape' in evaluated) || visitor.scope.loop?.jump) return evaluated
      // When evaluating a global timeline, the shared layout determines the
      // expanded note positions. Otherwise retain local barline evaluation.
      if (!timeline && continuations.length && !visitor.scope.layout) {
        let continued = evaluated.shape
        while (
          continued.kind === 'sequence' &&
          !continued.normalized &&
          !continued.continuationTarget &&
          continued.children.length === 1
        )
          continued = continued.children[0]!
        const stretch =
          (continued.kind === 'parallel' && continued.normalized) ||
          (continued.kind === 'sequence' &&
            (continued.normalized || continued.continuationTarget === 'all'))
        const duration = evaluated.shape.duration.sub(currentPulse.mul(elimination?.count ?? 0))
        if (stretch && duration.compare(0) > 0) {
          evaluated = visitor.visit(current.expression, {
            timeScale: visitor.scope.timeScale
              .mul(duration.add(currentPulse.mul(continuations.length)))
              .div(duration),
          })
          if (!('shape' in evaluated) || visitor.scope.loop?.jump) return evaluated
        }
      }
      let base = evaluated.shape
      if (elimination) {
        const removed = currentPulse.mul(elimination.count)
        if (removed.compare(base.duration) > 0)
          return {
            diagnostics: [
              ...evaluated.diagnostics,
              {
                code: 'XP_TAIL_ELIMINATION',
                severity: 'error',
                message: 'Tail elimination exceeds the score item duration.',
                locations: [elimination.location],
              },
            ],
          }
        base = trimShape(base, base.duration.sub(removed))
      }
      if (!continuations.length)
        return withVisitor(
          { shape: base, diagnostics: evaluated.diagnostics },
          visitorAfter(evaluated, visitor),
        )
      return withVisitor(
        {
          shape: sequence(
            [
              base,
              ...continuations.map<ContinueShape>((mark) => ({
                kind: 'continue',
                duration: currentPulse,
                origins: [origin(mark, 'duration')],
              })),
            ],
            [origin(current)],
          ),
          diagnostics: evaluated.diagnostics,
        },
        visitorAfter(evaluated, visitor),
      )
    }

    if (current.type === 'PitchContextChange') {
      try {
        const changed = applyPitchContextChange(current, context, environment)
        return {
          shape: withOccurrence(contextShape(current, changed, context), visitor),
          diagnostics: [],
        }
      } catch (error) {
        if (error instanceof EvaluationError) return { diagnostics: error.diagnostics }
        return { shape: withOccurrence(contextAnnotation(current), visitor), diagnostics: [] }
      }
    }
    const value = evaluateExpression(current, context, environment)
    if ('value' in value && value.value.kind === 'scoreFragment') {
      const fragment = value.value
      const scope = changeVisitor(visitor, (context) => ({
        ...context,
        lexicalEnvironment: {
          ...extendLexicalEnvironment(fragment.environment, {
            calls: environment?.calls ?? EMPTY_LEXICAL_ENVIRONMENT.calls,
          }),
          functionBudget: environment?.functionBudget,
        },
      })).spawn({ loop: undefined, subdivisionContext: visitor.scope.resolve })
      const body: Extract<Expression, { type: 'Sequence' }> =
        fragment.expression.type === 'Sequence'
          ? fragment.expression
          : {
              type: 'Sequence',
              items: [fragment.expression],
              location: fragment.expression.location,
            }
      const played = visitBlock(body, scope)
      const diagnostics = [...value.diagnostics, ...played.diagnostics]
      if (!hasShape(played)) return { diagnostics }
      return {
        shape: { ...annotateScoreUse(played.shape, origin(current)), isolatedDirectiveScope: true },
        diagnostics,
      }
    }
    if ('value' in value && value.value.kind === 'container') {
      const variables = new Map<string, EvaluatedLiteral>()
      const fragment = (item: EvaluatedLiteral): Expression => {
        if (item.kind !== 'container') {
          const name = `$container${variables.size}`
          variables.set(name, item)
          return { type: 'Identifier', name, location: current.location }
        }
        const children = item.values.map(fragment)
        const expression: Expression =
          item.composition === 'parallel'
            ? { type: 'Parallel', branches: children, location: current.location }
            : { type: 'Sequence', items: children, location: current.location }
        const composed: Expression = item.grouped
          ? { type: 'Group', expression, location: current.location }
          : expression
        const normalized: Expression = item.normalized
          ? {
              type: 'NormalizeToSlot',
              expression: children.length ? composed : null,
              location: current.location,
            }
          : composed
        return item.postfixMarks
          ? {
              type: 'PostfixExpression',
              expression: normalized,
              marks: [...item.postfixMarks],
              location: current.location,
            }
          : normalized
      }
      const expression = fragment(value.value)
      const result = changeVisitor(visitor, (context) => ({
        ...context,
        lexicalEnvironment: extendLexicalEnvironment(environment ?? EMPTY_LEXICAL_ENVIRONMENT, {
          variables,
        }),
      })).visit(expression)
      return { ...result, diagnostics: [...value.diagnostics, ...result.diagnostics] }
    }
    const evaluated = playablePitch(current, context, value)
    if (!('pitch' in evaluated)) return evaluated
    const shape: PlaybackAttackShape = {
      kind: 'attack',
      pitch: evaluated.pitch,
      duration: currentPulse,
      origins: evaluated.pitch.origins,
      rootPitch: context.rootPitch,
      dynamic: currentDynamic,
      velocity: DYNAMIC_VELOCITIES[currentDynamic],
      articulation: currentArticulation,
      directiveState: { ...currentDirectiveState },
      ...(currentArticulationMarks.length ? { articulationMarks: currentArticulationMarks } : {}),
      ...('raw' in current ? { authoredLabel: String(current.raw) } : {}),
      ...(evaluated.justIntonation ? { justIntonation: true } : {}),
      ...(current.type === 'DegreeLiteral' ||
      current.type === 'EqualDivisionLiteral' ||
      (current.type === 'QuantityLiteral' &&
        ['c', '¢', 'hz', 'khz'].includes(current.unit.toLowerCase()))
        ? { displayLabel: String(current.raw) }
        : {}),
    }
    if ('raw' in current) authoredLabels.set(shape, String(current.raw))
    if (!visitor.scope.layout && visitor.scope.timelineVisit)
      timeline?.attacks.set(shape.pitch, visitor.scope.timelineVisit)
    return { shape: withOccurrence(shape, visitor), diagnostics: evaluated.diagnostics }
  }

  const base: ScoreVisitorContext = {
    tempo: options.tempo === undefined ? undefined : new Fraction(options.tempo),
    timeSignature:
      inherited?.timeSignature ??
      (options.timeSignature?.origin
        ? { ...options.timeSignature, origin: options.timeSignature.origin }
        : undefined),
    pitchContext: options.pitchContext ?? DEFAULT_PITCH_CONTEXT,
    pulse,
    dynamic: options.dynamic ?? 'mf',
    articulation: new Fraction(options.articulation ?? 1),
    articulationMarks: options.articulationMarks ?? [],
    directiveState: initialDirectiveState,
    lexicalEnvironment: options.lexicalEnvironment,
  }
  const identity: ContextResolver = { cache: new WeakMap() }
  const start = options.beatOffset ?? new Fraction(0)
  const rootVisit: TimelineVisit = { key: '', offset: start, beat: start, children: new Map() }
  const visitor = new Visitor<ScoreExpression, VisitorScope, ScoreShapeEvaluationResult>(
    (current, active) => {
      try {
        const occurrence = current.expansionPath ?? active.scope.expansionPath
        let beat = active.scope.offset
        if (timeline) {
          const parent = active.scope.timelineVisit ?? rootVisit
          const { source, start, end } = current.location
          if (!timeline.sources.has(source)) timeline.sources.set(source, timeline.sources.size)
          const id = `${timeline.sources.get(source)}:${start.offset}:${end.offset}:${current.type}`
          const index = parent.children.get(id) ?? 0
          parent.children.set(id, index + 1)
          const key = `${parent.key}/${id}:${index}`
          beat = timeline.beats.get(key) ?? beat
          active = active.spawn({
            timelineVisit: {
              key,
              offset: active.scope.offset,
              beat,
              children: new Map(),
              parent: active.scope.timelineVisit,
            },
          })
        }
        const result = evaluateNode(current, at(active, active.scope.offset, occurrence, beat))
        if (
          active.scope.stopOnError &&
          result.diagnostics.some(({ severity }) => severity === 'error')
        )
          return { diagnostics: result.diagnostics }
        return result
      } catch (error) {
        return {
          diagnostics:
            error instanceof EvaluationError
              ? error.diagnostics
              : [
                  {
                    code: 'XP_CONTEXT',
                    severity: 'error',
                    message: error instanceof Error ? error.message : String(error),
                    locations: [current.location],
                  },
                ],
        }
      }
    },
    {
      ...contextScope(base),
      expansionPath: [],
      declarationScope: {},
      base,
      resolve: identity,
      subdivisionContext: identity,

      offset: start,
      timeScale: new Fraction(1),
    },
  )
  const result = visitor.visit(node)
  if (!('shape' in result)) return result
  const prevailing = visitorContext(visitorAfter(result, visitor))
  return {
    ...result,
    pitchContext: prevailing.pitchContext,
    directiveState: prevailing.directiveState,
    lexicalEnvironment: prevailing.lexicalEnvironment,
    visitorContext: prevailing,
  }
}
