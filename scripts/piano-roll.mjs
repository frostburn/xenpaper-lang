import { styleText } from 'node:util'
import { Fraction } from 'xen-dev-utils/fraction'

const formatCents = new Intl.NumberFormat('en', {
  maximumFractionDigits: 2,
  useGrouping: false,
}).format

const glyphColors = {
  '●': 'cyanBright',
  '│': 'cyan',
  '╱': 'yellow',
  '╲': 'yellow',
  '◆': 'magentaBright',
}

function getGlides(event) {
  const { automation } = event
  if (!automation) return []
  const segments = automation.segments?.length
    ? automation.segments
    : [{ ...automation, start: new Fraction(0) }]
  return segments.map((segment) => {
    const start = event.start.add(segment.start)
    return {
      start,
      end: start.add(segment.duration),
      from: segment.from.value.valueOf(),
      to: segment.to.value.valueOf(),
    }
  })
}

function makeRows(score) {
  const rows = new Map()
  const rowAt = (beat) => {
    const key = beat.toFraction()
    if (!rows.has(key)) rows.set(key, { beat, key, starts: [], ends: [], markers: [] })
    return rows.get(key)
  }
  let firstBeat = new Fraction(0)
  let lastBeat = score.duration
  for (const event of score.events) {
    const row = rowAt(event.start)
    if (event.start.compare(firstBeat) < 0) firstBeat = event.start
    if (event.start.compare(lastBeat) > 0) lastBeat = event.start
    if (event.kind === 'marker') {
      row.markers.push(event)
      continue
    }
    const end = event.start.add(event.duration)
    const note = {
      end,
      cents: event.pitch.value.valueOf(),
      label: event.label,
      glides: getGlides(event),
    }
    row.starts.push(note)
    rowAt(end).ends.push(note)
    if (end.compare(lastBeat) > 0) lastBeat = end
    for (const glide of note.glides) {
      if (glide.start.compare(end) < 0) rowAt(glide.start)
      if (glide.end.compare(end) < 0) rowAt(glide.end)
    }
  }
  rowAt(new Fraction(0))
  rowAt(score.duration)
  // Keep guide rows bounded for long scores. Event rows retain their exact beats.
  const guide = new Fraction(Math.max(1, Math.ceil(lastBeat.sub(firstBeat).valueOf() / 30)), 4)
  for (
    let beat = firstBeat.div(guide).ceil().mul(guide);
    beat.compare(lastBeat) < 0;
    beat = beat.add(guide)
  ) {
    rowAt(beat)
  }
  return [...rows.values()].sort((a, b) => a.beat.compare(b.beat))
}

function pitchAxis(rows) {
  let low = Infinity
  let high = -Infinity
  for (const row of rows) {
    for (const note of row.starts) {
      low = Math.min(low, note.cents)
      high = Math.max(high, note.cents)
      for (const { from, to } of note.glides) {
        low = Math.min(low, from, to)
        high = Math.max(high, from, to)
      }
    }
  }
  if (!Number.isFinite(low)) low = high = 0
  const step = Math.max(1, Math.ceil((high - low) / 48))
  const origin = (Math.floor(low / step) - 1) * step
  const tickSpacing = 12
  const width = 1 + tickSpacing * Math.max(2, Math.ceil((high - origin) / (step * tickSpacing)))
  return { step, origin, tickSpacing, width }
}

function soundingPitch(note, beat) {
  let cents = note.cents
  for (const { start, end, from, to } of note.glides) {
    if (beat.compare(start) < 0) break
    if (beat.compare(end) < 0) {
      const progress = beat.sub(start).div(end.sub(start)).valueOf()
      return [from + progress * (to - from), to < from ? '╱' : to > from ? '╲' : '│']
    }
    cents = to
  }
  return [cents, '│']
}

export function renderPianoRoll(score, { color = true } = {}) {
  const paint = (glyph) =>
    color ? styleText(glyphColors[glyph], glyph, { validateStream: false }) : glyph
  const rows = makeRows(score)
  const { step, origin, tickSpacing, width } = pitchAxis(rows)
  const beatWidth = rows.reduce((width, row) => Math.max(width, row.key.length), 4)
  const rule = Array.from({ length: width }, (_, column) => (column % tickSpacing ? '─' : '┬'))
  const ticks = rule
    .filter((cell) => cell === '┬')
    .map((_, index) => formatCents(origin + index * tickSpacing * step) + '¢')
    .map((label) => label.padEnd(tickSpacing))
    .join('')
    .trimEnd()
  const lines = [
    `Pitch in cents relative to C4 (${step}¢ per column)`,
    ' '.repeat(beatWidth + 3) + ticks,
    'Beat'.padStart(beatWidth) + '  ┌' + rule.join('') + '┐',
  ]

  const active = new Set()
  for (const { beat, key, starts, ends, markers } of rows) {
    const cells = Array(width).fill(' ')
    const put = (cents, glyph) => {
      const column = Math.round((cents - origin) / step)
      cells[column] = cells[column] === ' ' ? glyph : '◆'
    }
    for (const note of ends) active.delete(note)
    for (const note of active) put(...soundingPitch(note, beat))
    for (const note of starts) {
      put(note.cents, '●')
      if (beat.compare(note.end) < 0) active.add(note)
    }

    const barline = markers.some(({ marker }) => marker === 'barline')
    const track = cells
      .map((glyph, column) => {
        if (glyph !== ' ') return paint(glyph)
        if (barline) return '─'
        return column % tickSpacing ? ' ' : '·'
      })
      .join('')
    const labels = [
      ...starts.map(({ label, cents }) => {
        const pitch = formatCents(cents) + '¢'
        return label ? `${JSON.stringify(label)} ${pitch}` : pitch
      }),
      ...markers.map(({ marker, label }) => `${marker} ${JSON.stringify(label)}`),
    ]
    lines.push(
      `${key.padStart(beatWidth)}  │${track}│${labels.length ? '  ' + labels.join('  ') : ''}`,
    )
  }
  lines.push(' '.repeat(beatWidth + 2) + '└' + '─'.repeat(width) + '┘')
  lines.push(
    `${paint('●')} attack   ${paint('│')} held   ${paint('╱')}${paint('╲')} glide   ${paint('◆')} shared column`,
  )
  return lines.join('\n')
}
