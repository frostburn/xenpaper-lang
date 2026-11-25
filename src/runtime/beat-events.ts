import { Fraction } from 'xen-dev-utils/fraction'
import type { Program } from '../parser.js'
import type { Diagnostic } from '../diagnostics.js'
import { DYNAMIC_VELOCITIES } from './directives.js'
import { evaluateProgramSemantics } from './score-shape.js'
import { layoutNotes, type PlacedNote } from './note-layout.js'
import type {
  AttackShape,
  BeatTimedMarkerEvent,
  BeatTimedNoteEvent,
  BeatTimedScore,
  ScoreShape,
  ScoreShapeOptions,
} from './types.js'

export type BeatEventExpansionOptions = ScoreShapeOptions
export type BeatEventExpansionResult =
  | { readonly score: BeatTimedScore; readonly diagnostics: readonly Diagnostic[] }
  | { readonly diagnostics: readonly Diagnostic[] }
type Control = { actual: Fraction; dynamic: Fraction; articulation: Fraction }
type Groove = { origin: Fraction; cycle: Fraction; points: Control[] }
type GrooveChange = { start: Fraction; groove?: Groove }
interface Flattened {
  score: BeatTimedScore
  diagnostics: Diagnostic[]
  grooveChanges: GrooveChange[]
}
const one = new Fraction(1)

function buildGroove(score: BeatTimedScore, origin: Fraction): Groove | undefined {
  const notes = score.events.filter((n) => n.kind === 'note')
  if (notes.length < 2 || !score.duration.n) return
  const points = notes.map((note, index) => {
    const width = (notes[index + 1]?.start ?? score.duration).sub(note.start)
    return {
      actual: note.start,
      dynamic: note.dynamic.div(DYNAMIC_VELOCITIES.mf),
      articulation: width.n ? note.duration.div(width) : one,
    }
  })
  return { origin, cycle: score.duration, points }
}

/** Interpolate timing to the cycle boundary and expression back to the first control. */
function sample(groove: Groove, beat: Fraction) {
  const { origin, cycle, points } = groove
  const phase = beat.sub(origin).mmod(cycle)
  const position = phase.div(cycle).mul(points.length)
  const index = position.floor().valueOf()
  const t = position.sub(index)
  const a = points[index]!
  const b = points[(index + 1) % points.length]!
  const interpolate = (x: Fraction, y: Fraction) => x.add(y.sub(x).mul(t))
  return {
    beat: beat
      .sub(phase)
      .add(interpolate(a.actual, index + 1 === points.length ? cycle : b.actual)),
    dynamic: interpolate(a.dynamic, b.dynamic),
    articulation: interpolate(a.articulation, b.articulation),
  }
}

function marker(
  node: Extract<ScoreShape, { kind: BeatTimedMarkerEvent['marker'] }>,
  start: Fraction,
): BeatTimedMarkerEvent {
  const base = {
    kind: 'marker' as const,
    start,
    origins: node.origins,
    ...(node.expansionPath && { expansionPath: node.expansionPath }),
  }
  switch (node.kind) {
    case 'barline':
      return {
        ...base,
        marker: node.kind,
        label: node.style,
        style: node.style,
        ...(node.endingNumber !== undefined && { endingNumber: node.endingNumber }),
      }
    case 'dynamic':
      return { ...base, marker: node.kind, mark: node.mark, label: node.mark }
    case 'time-signature':
      return {
        ...base,
        marker: node.kind,
        numerator: node.numerator,
        denominator: node.denominator,
        label: `${node.numerator}/${node.denominator}`,
      }
    case 'tempo':
      return { ...base, marker: node.kind, bpm: node.bpm, label: node.bpm.toFraction() }
    case 'annotation':
      return { ...base, marker: node.kind, label: node.text }
  }
}

type ScheduledNote = {
  event: BeatTimedNoteEvent
  timing: PlacedNote
  articulation: Fraction
  groove?: Groove | null
}
type PlaybackScope = { groove?: Groove | null; drones: PlacedNote[] }

function perform(
  note: ScheduledNote,
  timeline: Flattened | undefined,
  offset: Fraction,
): BeatTimedNoteEvent {
  const { timing, articulation } = note
  const { start, duration, automation, origins } = timing
  const event = { ...note.event, start, duration, automation, origins }
  const absolute = start.add(offset)
  const groove =
    note.groove === undefined
      ? timeline?.grooveChanges.findLast((change) => change.start.compare(absolute) <= 0)?.groove
      : note.groove
  if (!groove) return { ...event, duration: event.duration.mul(articulation) }
  const onset = sample(groove, absolute)
  const release = sample(groove, absolute.add(event.duration))
  return {
    ...event,
    start: onset.beat.sub(offset),
    duration: release.beat.sub(onset.beat).mul(articulation).mul(onset.articulation),
    dynamic: event.dynamic.mul(onset.dynamic),
  }
}

export function flattenScoreSemantics(
  shape: ScoreShape,
  timeline?: Flattened,
  beatOffset: Fraction = new Fraction(0),
): Flattened {
  const diagnostics: Diagnostic[] = []
  const events: (BeatTimedMarkerEvent | ScheduledNote)[] = []
  const grooveChanges: GrooveChange[] = []
  const scopes: PlaybackScope[] = []
  let scope: PlaybackScope = { drones: [] }
  function release(end: Fraction) {
    for (const drone of scope.drones) drone.duration = end.sub(drone.start)
    scope.drones = []
  }
  const layout = layoutNotes(shape, {
    enterScope() {
      scopes.push(scope)
      scope = { groove: scope.groove, drones: [] }
    },
    leaveScope(end) {
      release(end)
      const previous = scope.groove
      scope = scopes.pop()!
      if (scope.groove !== previous)
        grooveChanges.push({ start: end.add(beatOffset), groove: scope.groove ?? undefined })
    },
    orphan(node) {
      diagnostics.push({
        severity: 'error',
        code: 'XP_CONTINUE_WITHOUT_ATTACK',
        message: 'A continuation requires an active note.',
        locations: node.origins.map((origin) => origin.location),
      })
    },
    attack(node, timing) {
      const dynamic =
        (node as AttackShape & { velocity?: Fraction }).velocity ?? DYNAMIC_VELOCITIES.mf
      events.push({
        timing,
        groove: scope.groove,
        articulation: node.articulation ?? one,
        event: {
          kind: 'note',
          start: timing.start,
          duration: timing.duration,
          dynamic,
          directiveState: node.directiveState,
          pitch: node.pitch,
          rootPitch: node.rootPitch,
          label: node.authoredLabel ?? node.displayLabel,
          origins: node.origins,
          ...(node.expansionPath && { expansionPath: node.expansionPath }),
        },
      })
    },
    control(node, start, sound) {
      if (node.kind === 'groove' || node.kind === 'drone') {
        const template = node.template && flattenScoreSemantics(node.template)
        if (template) diagnostics.push(...template.diagnostics)
        if (node.kind === 'groove') {
          const absolute = start.add(beatOffset)
          scope.groove = template ? (buildGroove(template.score, absolute) ?? null) : null
          grooveChanges.push({ start: absolute, groove: scope.groove ?? undefined })
        } else {
          release(start)
          for (const event of template?.score.events ?? []) {
            if (event.kind !== 'note') continue
            const timing = sound(
              { ...event, duration: new Fraction(0), origins: [...node.origins, ...event.origins] },
              start,
            )
            scope.drones.push(timing)
            events.push({ timing, groove: scope.groove, articulation: one, event })
          }
        }
      } else if (node.kind !== 'clef' && node.kind !== 'key-signature')
        events.push(marker(node, start))
    },
  })
  diagnostics.push(...layout.diagnostics)
  release(shape.duration)
  return {
    score: {
      duration: shape.duration,
      events: events
        .map((entry) => ('event' in entry ? perform(entry, timeline, beatOffset) : entry))
        .sort((a, b) => a.start.compare(b.start)),
    },
    diagnostics,
    grooveChanges: grooveChanges.sort((a, b) => a.start.compare(b.start)),
  }
}

export function expandToBeatEvents(
  program: Program,
  options: BeatEventExpansionOptions = {},
): BeatEventExpansionResult {
  const result = evaluateProgramSemantics(program, options)
  if (!('shape' in result)) return { diagnostics: result.diagnostics }
  const { shape: setup, timelineShape } = options.initialization ?? {}
  const timeline = timelineShape && flattenScoreSemantics(timelineShape)
  const shape: ScoreShape = setup
    ? {
        kind: 'sequence',
        children: [setup, result.shape],
        duration: result.shape.duration,
        origins: [],
      }
    : result.shape
  const played = flattenScoreSemantics(shape, timeline, options.beatOffset)
  const diagnostics = [
    ...result.diagnostics,
    ...(timeline?.diagnostics ?? []),
    ...played.diagnostics,
  ]
  return diagnostics.some((d) => d.severity === 'error')
    ? { diagnostics }
    : { score: played.score, diagnostics }
}
