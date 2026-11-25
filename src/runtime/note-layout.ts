import { Fraction } from 'xen-dev-utils/fraction'
import type { Diagnostic } from '../diagnostics.js'
import type { AttackShape, ContinueShape, ScoreShape, SourceOrigin } from './types.js'

/** A written rhythmic slot and the sounding note it contributes can have different endpoints. */
export interface PlacedNote {
  readonly pitch: AttackShape['pitch']
  readonly slotStart: Fraction
  start: Fraction
  duration: Fraction
  origins: readonly SourceOrigin[]
  automation: AttackShape['automation']
  glideComplete?: boolean
}

interface SustainTarget {
  first: number
  last: number
  // A normalized slot stretches from its written start. A chord or tie stretches
  // from its earliest sounding note, which can follow rests in every branch.
  anchor?: Fraction
  // Ties and synthetic glissando continuations can infer the span from the next mark.
  span?: Fraction
  unevenParallel?: boolean
}

export type Sound = Pick<AttackShape, 'pitch' | 'duration' | 'origins' | 'automation'>
type Control = Exclude<
  ScoreShape,
  { kind: 'attack' | 'rest' | 'continue' | 'sequence' | 'parallel' }
>
/** Playback supplies directive scopes and may start additional sounding notes from a drone. */
export interface LayoutVisitor {
  enterScope(): void
  leaveScope(end: Fraction): void
  attack(node: AttackShape, note: PlacedNote): void
  control(
    node: Control,
    start: Fraction,
    sound: (source: Sound, start: Fraction) => PlacedNote,
  ): void
  orphan(node: ContinueShape): void
}

export function layoutNotes(shape: ScoreShape, visitor?: LayoutVisitor) {
  const notes: PlacedNote[] = []
  const orphaned: ContinueShape[] = []
  const diagnostics: Diagnostic[] = []
  function earliestOnset({ first, last }: SustainTarget): Fraction {
    let earliest = notes[first]!.start
    for (let i = first + 1; i < last; i++) {
      const onset = notes[i]!.start
      if (onset.compare(earliest) < 0) earliest = onset
    }
    return earliest
  }
  function sound(source: Sound, start: Fraction): PlacedNote {
    return {
      pitch: source.pitch,
      slotStart: start,
      start,
      duration: source.duration,
      origins: source.origins,
      automation: source.automation,
    }
  }
  function visit(node: ScoreShape, start: Fraction, active?: SustainTarget) {
    if (node.isolatedDirectiveScope) visitor?.enterScope()
    const next = walk(node, start, active)
    if (node.isolatedDirectiveScope) visitor?.leaveScope(start.add(node.duration))
    return next
  }
  function walk(
    node: ScoreShape,
    start: Fraction,
    active?: SustainTarget,
  ): SustainTarget | undefined {
    const first = notes.length
    switch (node.kind) {
      case 'attack': {
        const note = sound(node, start)
        notes.push(note)
        visitor?.attack(node, note)
        return { first, last: notes.length, anchor: start, span: node.duration }
      }
      case 'rest':
        return undefined
      case 'continue': {
        if (!active) {
          orphaned.push(node)
          visitor?.orphan(node)
          return
        }
        // Glissando targets are lowered to continuations internally.
        if (active.unevenParallel && node.extendsAutomation !== false) {
          diagnostics.push({
            code: 'XP_UNEVEN_PARALLEL_CONTINUATION',
            severity: 'error',
            message:
              'Use branch-local continuations in a parallel with uneven attacks or releases.',
            locations: node.origins.map((origin) => origin.location),
          })
          return active
        }
        const anchor = active.anchor ?? earliestOnset(active)
        const unit = active.span ?? node.duration
        const span = unit.add(node.duration)
        const factor = unit.n ? span.div(unit) : new Fraction(1)
        for (let i = active.first; i < active.last; i++) {
          const note = notes[i]!
          note.start = anchor.add(note.start.sub(anchor).mul(factor))
          note.duration = unit.n ? note.duration.mul(factor) : note.duration.add(node.duration)
          note.origins = [...note.origins, ...node.origins]
          if (node.extendsAutomation === false) note.glideComplete = true
          if (note.automation && !note.glideComplete) {
            note.automation = { ...note.automation, duration: note.duration }
          }
        }
        return { ...active, anchor, span }
      }
      case 'sequence': {
        let cursor = start
        for (const child of node.children) {
          active = visit(child, cursor, active)
          cursor = cursor.add(child.duration)
        }
        if (!node.normalized && node.continuationTarget !== 'all') return active
        if (first === notes.length) return undefined
        return {
          first,
          last: notes.length,
          ...(node.normalized && { anchor: start, span: node.duration }),
        }
      }
      case 'parallel':
        for (const branch of node.branches) {
          visitor?.enterScope()
          visit(branch, start)
          visitor?.leaveScope(start.add(node.duration))
        }
        if (first === notes.length) return undefined
        const last = notes.length
        if (node.normalized) return { first, last, anchor: start, span: node.duration }
        const onset = notes[first]!.start
        const release = start.add(node.duration)
        for (let i = first; i < last; i++) {
          const note = notes[i]!
          if (!note.start.equals(onset) || !note.start.add(note.duration).equals(release))
            return { first, last, unevenParallel: true }
        }
        return { first, last, anchor: onset, span: release.sub(onset) }
      default:
        visitor?.control(node, start, sound)
        return active
    }
  }
  visit(shape, new Fraction(0))
  return { notes, orphaned, diagnostics }
}
