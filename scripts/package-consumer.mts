import {
  constructStaffNotationShape,
  evaluateProgramShape,
  expandRepeats,
  expandToBeatEvents,
  parse,
  tryParse,
  type Program,
  type XenpaperParserOptions,
} from 'xenpaper-lang'

const options: XenpaperParserOptions = { grammarSource: 'smoke-test' }
const program: Program = parse('[C D E] F=', options)
if (program.location.source !== options.grammarSource) throw new Error('Missing source location')
const result = expandToBeatEvents(program)
if (result.diagnostics.length || !('score' in result)) throw new Error('Could not evaluate score')
const starts = result.score.events
  .filter((event) => event.kind === 'note')
  .map((note) => note.start.toFraction())
if (starts.join(',') !== '0,1/3,2/3,1' || !result.score.duration.equals(3)) {
  throw new Error('Unexpected note timing: ' + starts.join(','))
}

const syntax = tryParse('(', options)
if ('program' in syntax || syntax.diagnostics[0]?.locations[0]?.source !== 'smoke-test') {
  throw new Error('Missing located syntax diagnostic')
}
const parsed = tryParse('C, |: D :|', options)
if (!('program' in parsed)) throw new Error('Expected a program')
const parallel = expandRepeats(parsed.program).program?.body[0]
const branch = parallel?.type === 'Parallel' && parallel.branches[1]
const pitch = branch && branch.type === 'Sequence' && branch.items[1]
if (
  !pitch ||
  pitch.type !== 'PitchLiteral' ||
  pitch.nominal.value !== 'D' ||
  pitch.expansionPath[0]?.iteration !== 1
) {
  throw new Error('Missing typed occurrence on a nested pitch')
}
const written = parse('@time(3/4) @tempo(1beat/700ms) @p C D E ||', options)
const settings = { allowTempoDirective: true }
const marked = expandToBeatEvents(written, settings)
if (!('score' in marked)) throw new Error('Expected a marked score')
const markers = marked.score.events.filter((event) => event.kind === 'marker')
if (
  !markers.some(
    (event) =>
      event.marker === 'time-signature' && event.numerator === 3 && event.denominator === 4,
  ) ||
  !markers.some((event) => event.marker === 'tempo' && event.bpm.toFraction() === '600/7') ||
  !markers.some((event) => event.marker === 'dynamic' && event.mark === 'p') ||
  !markers.some((event) => event.marker === 'barline' && event.style === 'double')
) {
  throw new Error('Missing structured meter, tempo, dynamic or barline')
}

const shaped = evaluateProgramShape(written, settings)
if (!('shape' in shaped)) throw new Error('Expected a notation tree')
const staff = constructStaffNotationShape(shaped.shape)
if (staff.kind !== 'sequence') throw new Error('Expected a staff sequence')
const tempo = staff.children.find((item) => item.kind === 'annotation' && item.marker === 'tempo')
if (
  tempo?.kind !== 'annotation' ||
  tempo.marker !== 'tempo' ||
  tempo.bpm.toFraction() !== '600/7' ||
  tempo.origins?.[0]?.location.source !== 'smoke-test'
) {
  throw new Error('Missing staff tempo or source span')
}
