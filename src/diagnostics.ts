import type { LocationRange } from 'peggy'

export type DiagnosticSeverity = 'error' | 'warning'

export interface Diagnostic {
  readonly code: string
  readonly severity: DiagnosticSeverity
  readonly message: string
  readonly locations: readonly LocationRange[]
}

/** Carry diagnostics through evaluation paths that signal failures with exceptions. */
export class EvaluationError extends Error {
  constructor(readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics[0]?.message)
  }
}

/** Structural control-flow and continuation failures must still terminate evaluation. */
export function catchableDiagnostic(diagnostics: readonly Diagnostic[]): Diagnostic | undefined {
  const errors = diagnostics.filter(({ severity }) => severity === 'error')
  if (
    errors.some(
      ({ code }) =>
        code === 'XP_EXPANSION_LIMIT' ||
        code === 'XP_REPEAT_EXPANSION_LIMIT' ||
        code === 'XP_REPEAT_COUNT' ||
        code === 'XP_CONTINUE_WITHOUT_ATTACK' ||
        code === 'XP_UNEVEN_PARALLEL_CONTINUATION' ||
        code === 'XP_RECURSION' ||
        code === 'XP_LOOP_JUMP' ||
        code === 'XP_FUNCTION_STATEMENT' ||
        code === 'XP_DUPLICATE_FUNCTION' ||
        code === 'XP_MISSING_RETURN' ||
        code === 'XP_RETURN_SCOPE',
    )
  )
    return undefined
  return errors[0]
}
