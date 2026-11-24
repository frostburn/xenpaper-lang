import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const usage = 'Usage: node scripts/dump-events.mjs [--json] [--sample NAME]... FILE'

function dumpPitch(pitch) {
  const cents = pitch.value.valueOf()
  return pitch.kind === 'frequency'
    ? { kind: pitch.kind, cents, hz: pitch.frequency.valueOf() }
    : { kind: pitch.kind, cents }
}

function dumpGlide(glide) {
  return {
    curve: glide.curve,
    from: dumpPitch(glide.from),
    to: dumpPitch(glide.to),
    duration: glide.duration.toFraction(),
  }
}

function dumpEvent(event) {
  const start = event.start.toFraction()
  const origins = event.origins.map(({ role, location: { start, end } }) => ({ role, start, end }))
  if (event.kind === 'marker') {
    return { kind: event.kind, start, marker: event.marker, label: event.label, origins }
  }
  const { automation } = event
  return {
    kind: event.kind,
    start,
    duration: event.duration.toFraction(),
    label: event.label ?? null,
    pitch: dumpPitch(event.pitch),
    dynamic: event.dynamic.toFraction(),
    origins,
    automation: automation && {
      ...dumpGlide(automation),
      segments: automation.segments?.map((segment) => ({
        start: segment.start.toFraction(),
        ...dumpGlide(segment),
      })),
    },
  }
}

function printTable(duration, events) {
  const rows = [['Beat', 'Duration', 'Event', 'Label', 'Pitch', 'Dynamic', 'Source']]
  for (const event of events) {
    const position = event.origins[0]?.start
    const source = position ? `${position.line}:${position.column}` : '–'
    const label = event.label === null ? '–' : JSON.stringify(event.label)
    if (event.kind === 'marker') {
      rows.push([event.start, '–', event.marker, label, '–', '–', source])
    } else {
      const pitch =
        event.pitch.kind === 'frequency' ? `${event.pitch.hz} Hz` : `${event.pitch.cents}¢`
      rows.push([event.start, event.duration, 'note', label, pitch, event.dynamic, source])
    }
  }

  const widths = rows[0].map((column) => column.length)
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index], cell.length)
    })
  }
  console.log(`Score duration: ${duration} beats`)
  for (const row of rows) {
    console.log(
      row
        .map((cell, index) => cell.padEnd(widths[index]))
        .join('  ')
        .trimEnd(),
    )
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
      sample: { type: 'string', multiple: true },
    },
    allowPositionals: true,
  })
  if (values.help) {
    console.log(usage)
    return
  }
  if (positionals.length !== 1) {
    console.error('Expected one score file.\n' + usage)
    process.exitCode = 1
    return
  }
  const [file] = positionals
  const source = await readFile(file, 'utf8')
  const { expandToBeatEvents, parse } = await import('../dist/index.js')

  const report = (severity, message, location) => {
    const position = location ? `:${location.start.line}:${location.start.column}` : ''
    console.error(`${file}${position}: ${severity}: ${message}`)
  }

  let program
  try {
    program = parse(source, { grammarSource: file, drumSamples: values.sample })
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
    report('error', error.message, error.location)
    process.exitCode = 1
    return
  }

  const result = expandToBeatEvents(program)
  for (const { code, severity, message, locations } of result.diagnostics) {
    report(severity, `${code}: ${message}`, locations[0])
  }
  if (!('score' in result)) {
    process.exitCode = 1
    return
  }

  const { score } = result
  const duration = score.duration.toFraction()
  const events = score.events.map(dumpEvent)
  if (values.json) console.log(JSON.stringify({ duration, events }, null, 2))
  else printTable(duration, events)
}

try {
  await main()
} catch (error) {
  console.error(error.message)
  if (error.code?.startsWith('ERR_PARSE_ARGS')) console.error(usage)
  process.exitCode = 1
}
