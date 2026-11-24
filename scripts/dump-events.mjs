import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

const usage =
  'Usage: node scripts/dump-events.mjs [--json | --piano-roll [--no-color]] [--sample NAME]... (FILE | --source TEXT)'

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
      'piano-roll': { type: 'boolean' },
      'no-color': { type: 'boolean' },
      sample: { type: 'string', multiple: true },
      source: { type: 'string', short: 'e' },
    },
    allowPositionals: true,
  })
  if (values.help) {
    console.log(usage)
    return
  }
  if (values.json && values['piano-roll']) {
    console.error('Choose one output format.\n' + usage)
    process.exitCode = 1
    return
  }
  const inline = values.source !== undefined
  if (positionals.length !== (inline ? 0 : 1)) {
    console.error('Provide one score file or --source TEXT.\n' + usage)
    process.exitCode = 1
    return
  }
  const [file] = positionals
  const source = values.source ?? (await readFile(file, 'utf8'))
  const sourceName = file ?? '<inline>'
  const { expandToBeatEvents, parse } = await import('../dist/index.js')

  const report = (severity, message, location) => {
    const position = location ? `:${location.start.line}:${location.start.column}` : ''
    console.error(`${sourceName}${position}: ${severity}: ${message}`)
  }

  let program
  try {
    program = parse(source, { grammarSource: sourceName, drumSamples: values.sample })
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
  if (values['piano-roll']) {
    const { renderPianoRoll } = await import('./piano-roll.mjs')
    console.log(renderPianoRoll(score, { color: !values['no-color'] }))
    return
  }
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
