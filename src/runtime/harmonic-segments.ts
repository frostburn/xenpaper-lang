import type { Diagnostic } from '../diagnostics.js'
import type { EnumeratedChord, Expression, IntegerLiteral } from '../parser.js'
import type { ExpressionEvaluator } from './builtins.js'

export function expandHarmonicSegment(
  chord: EnumeratedChord,
  evaluate: ExpressionEvaluator,
): {
  expressions: Expression[]
  diagnostics: Diagnostic[]
} {
  const diagnostics: Diagnostic[] = []
  let members = chord.enumerands
  if (!members) {
    const endpoint = (node: Expression) => {
      const result = evaluate(node)
      diagnostics.push(...result.diagnostics)
      if (!('value' in result) || result.value.kind !== 'scalar') return undefined
      const exact = result.value.value.exactRational()
      return exact?.d === 1 ? BigInt(exact.n) * BigInt(exact.s) : undefined
    }
    const start = endpoint(chord.first)
    const end = endpoint(chord.rangeEnd!)
    if (start === undefined || end === undefined) {
      diagnostics.push({
        code: 'XP_TYPE_MISMATCH',
        severity: 'error',
        locations: [chord.location],
        message: 'Enumerated chord range endpoints must be exact integers.',
      })
      return { expressions: [], diagnostics }
    }
    const step = start <= end ? 1n : -1n
    const length = (end - start) * step + 1n
    if (length > 10_000n) {
      diagnostics.push({
        code: 'XP_EXPANSION_LIMIT',
        severity: 'error',
        locations: [chord.location],
        message: 'Enumerated chord exceeds the 10000-member expansion limit.',
      })
      return { expressions: [], diagnostics }
    }
    members = Array.from({ length: Number(length) }, (_, i): IntegerLiteral => {
      const value = String(start + BigInt(i) * step)
      return { type: 'IntegerLiteral', value, raw: value, location: chord.location }
    })
  }
  const expressions = members.map((member): Expression => ({
    type: 'BinaryExpression',
    operator: '/',
    left: chord.inverted ? chord.first : member,
    right: chord.inverted ? member : chord.first,
    location: chord.location,
  }))
  return { expressions, diagnostics }
}
