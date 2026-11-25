import { Fraction } from 'xen-dev-utils/fraction'
import type { Diagnostic } from '../diagnostics.js'
import type { AttackShape, ContinueShape, ScoreShape, SourceOrigin } from './types.js'

/** A written rhythmic slot and the sounding note it contributes can have different endpoints. */
export interface PlacedNote {
  readonly pitch: AttackShape['pitch']
  start: Fraction
  duration: Fraction
  origins: readonly SourceOrigin[]
  automation: AttackShape['automation']
  glideComplete?: boolean
}

interface SustainTarget {
  first: number
  last: number
  anchor?: Fraction
  span?: Fraction
  slot?: { first: number; last: number }
  tieEnd?: Fraction
  unevenParallel?: boolean
}

interface PlacedShape {
  readonly shape: ScoreShape
  start: Fraction
  end: Fraction
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
  const placements: PlacedShape[] = []
  const events: (() => void)[] = []
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
      start,
      duration: source.duration,
      origins: source.origins,
      automation: source.automation,
    }
  }
  function visit(node: ScoreShape, start: Fraction, active?: SustainTarget) {
    const position = { shape: node, start, end: start.add(node.duration) }
    const index = placements.push(position) - 1
    if (visitor && node.isolatedDirectiveScope) events.push(() => visitor.enterScope())
    const next = walk(node, position, index, active)
    if (visitor && node.isolatedDirectiveScope) events.push(() => visitor.leaveScope(position.end))
    return next
  }
  function walk(
    node: ScoreShape,
    position: PlacedShape,
    positionIndex: number,
    active?: SustainTarget,
  ): SustainTarget | undefined {
    const { start, end } = position
    const first = notes.length
    switch (node.kind) {
      case 'attack': {
        const note = sound(node, start)
        notes.push(note)
        if (visitor) events.push(() => visitor.attack(node, note))
        return { first, last: notes.length, anchor: start, span: node.duration }
      }
      case 'rest':
        return undefined
      case 'continue': {
        if (!active) {
          orphaned.push(node)
          if (visitor) events.push(() => visitor.orphan(node))
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
        const { tieEnd, slot } = active
        const anchor = active.anchor ?? tieEnd ?? earliestOnset(active)
        const unit = active.span ?? node.duration
        const span = unit.add(node.duration)
        const factor = !tieEnd && unit.n ? span.div(unit) : new Fraction(1)
        for (let i = active.first; i < active.last; i++) {
          const note = notes[i]!
          if (tieEnd && !note.start.add(note.duration).equals(tieEnd)) continue
          note.start = anchor.add(note.start.sub(anchor).mul(factor))
          note.duration =
            tieEnd || !unit.n ? note.duration.add(node.duration) : note.duration.mul(factor)
          note.origins = [...note.origins, ...node.origins]
          if (node.extendsAutomation === false) note.glideComplete = true
          if (note.automation && !note.glideComplete) {
            note.automation = { ...note.automation, duration: note.duration }
          }
        }
        if (slot) {
          for (let i = slot.first; i < slot.last; i++) {
            const placed = placements[i]!
            placed.start = anchor.add(placed.start.sub(anchor).mul(factor))
            placed.end = anchor.add(placed.end.sub(anchor).mul(factor))
          }
        }
        return { ...active, anchor, span, ...(tieEnd && { tieEnd: tieEnd.add(node.duration) }) }
      }
      case 'sequence': {
        let cursor = start
        for (const child of node.children) {
          active = visit(child, cursor, active)
          cursor = cursor.add(child.duration)
        }
        if (!node.normalized && !node.continuationTarget) return active
        if (first === notes.length) return undefined
        if (!node.normalized && node.continuationTarget === 'all')
          return { first, last: notes.length }
        if (!node.normalized) {
          for (let i = first; i < notes.length; i++) {
            const note = notes[i]!
            if (note.start.add(note.duration).equals(end))
              return { first, last: notes.length, tieEnd: end }
          }
          return undefined
        }
        return {
          first,
          last: notes.length,
          anchor: start,
          span: node.duration,
          slot: { first: positionIndex, last: placements.length },
        }
      }
      case 'parallel':
        for (const branch of node.branches) {
          if (visitor) events.push(() => visitor.enterScope())
          visit(branch, start)
          if (visitor) events.push(() => visitor.leaveScope(position.end))
        }
        if (first === notes.length) return undefined
        const last = notes.length
        if (node.normalized)
          return {
            first,
            last,
            anchor: start,
            span: node.duration,
            slot: { first: positionIndex, last: placements.length },
          }
        const onset = notes[first]!.start
        for (let i = first; i < last; i++) {
          const note = notes[i]!
          if (!note.start.equals(onset) || !note.start.add(note.duration).equals(end))
            return { first, last, unevenParallel: true }
        }
        return { first, last, anchor: onset, span: end.sub(onset) }
      default:
        if (visitor) events.push(() => visitor.control(node, position.start, sound))
        return active
    }
  }
  visit(shape, new Fraction(0))
  events.forEach((event) => event())
  return { notes, orphaned, diagnostics, placements }
}
