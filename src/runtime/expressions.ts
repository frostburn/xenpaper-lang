import { parse, type Expression, type FunctionParameter } from '../parser.js'
import { Fraction, mmod } from 'xen-dev-utils/fraction'
import { EvaluationError, type Diagnostic } from '../diagnostics.js'
import { isPositiveRationalRatio, Value } from '../value.js'
import { evaluateBuiltinArgument, evaluateBuiltinCall, requireInteger } from './builtins.js'
import { evaluateLiteral, type NumericLiteralNode } from './literals.js'
import {
  executeFunctionStatements,
  type FunctionBindings,
  type ReturnEvaluator,
} from './function-statements.js'
import { expandHarmonicSegment } from './harmonic-segments.js'
import { needsScorePlayback } from './score-fragments.js'
import { equaveShift as modifierEquaveShift } from './pitch-modifiers.js'
import type {
  EvaluatedLiteral,
  CallableValue,
  FunctionDefinition,
  LexicalEnvironment,
  PitchOffsetValue,
  ScalarValue,
  StringValue,
  SourceOrigin,
} from './types.js'
import type { MosContext, PitchContext, PrimeMapping } from './types.js'
import {
  callableArity,
  EMPTY_LEXICAL_ENVIRONMENT,
  extendLexicalEnvironment,
  isCallableValue,
} from './types.js'
import {
  createPitchContext,
  DEFAULT_PITCH_CONTEXT,
  evaluateIntervalLiteral,
  evaluateMosIntervalLiteral,
  evaluatePitchLiteral,
  scalePitchOffset,
  mapFormula,
  spellIntervalFormula,
  spellPitchDifference,
  transposePitchSpelling,
  requirePitchOperator,
} from './pitches.js'

const MOS_HALF_ALTERATIONS: Readonly<Record<string, number>> = {
  '&': 2,
  '@': -2,
  e: 1,
  a: -1,
  _: 0,
  '♮': 0,
}

export type ExpressionEvaluationResult =
  | { readonly value: EvaluatedLiteral; readonly diagnostics: readonly Diagnostic[] }
  | { readonly diagnostics: readonly Diagnostic[] }

/** Xenpaper declarations installed as the outermost lexical scope by default. */
export const PRELUDE = `
let pi <- 3.141592653589793r
fn sqrt(radicand: ratio) { ret radicand ** 1/2 }
fn range(start: integer, end: integer <- niente, step: integer <- 1/1) {
  # Only a missing end gives different results for the two fallbacks.
  if((end al 0) @ne (end al 1)) {
    end <- start
    start <- 0/1
  }
  step <- step al 1/1
  if(step @eq 0) { throw(<<Range step must be nonzero.>>) }
  if((step @gt 0 @and start @ge end) @or (step @lt 0 @and start @le end)) {
    ret asSequence(())
  }
  let span <- (end - start) / step
  # Round up to count the last starting value when the step overshoots end.
  let count <- span - (span modc 1) + 1
  let indices <- (1::count) - 1
  let odd <- indices mod 2
  # Split offsets so large steps across zero can stay exact.
  let halfOffset <- (indices - odd) / 2 * step
  ret asSequence(start + halfOffset + halfOffset + odd * step)
}
fn prod(factors: container) { ret arrayReduce((total, element) => total * ratio(element), factors, 1/1) }
fn ground(scale: container) { ret scale - pitch(scale[0]) }
fn equaveReduce(scale: container, equave: ratio <- niente) {
  let actualEquave <- equave al scale[-1]
  ret ratio(scale) rdc ratio(actualEquave)
}
fn cps(factors: container<ratio>, count: integer, equave: ratio <- niente, withUnity: boolean <- false) {
  let products <- sorted(arrayMap((combination) => prod(combination), kCombinations(factors, count)))
  let grounded <- products if (withUnity al false) else ground(products)
  let actualEquave <- equave al (pitch(2/1) + grounded[0])
  ret asSequence(sorted(equaveReduce(grounded, actualEquave)))
}
fn eulerGenus(guide: integer, root: integer <- 1/1, equave: ratio <- 2/1) {
  if(guide @le 0) { throw(<<Guide tone must be a positive integer.>>) }
  if(root @le 0) { throw(<<Root tone must be a positive integer.>>) }
  if(equave @le 1) { throw(<<Equave must be greater than one.>>) }
  if(guide mod root) { throw(<<Root must divide the guide tone.>>) }
  while(@not (guide mod equave)) {
    guide <- guide / equave
  }
  let pitches <- (equave,)
  for(harmonic of 1::guide) {
    if(@not (guide mod harmonic)) {
      let reduced <- (harmonic / root) rd equave
      if(reduced @ne 1) {
        pitches <- flat((pitches, reduced))
      }
    }
  }
  ret asSequence(sorted(pitches))
}
`

let cachedPreludeEnvironment: LexicalEnvironment | undefined

export function preludeEnvironment(): LexicalEnvironment {
  if (cachedPreludeEnvironment) return cachedPreludeEnvironment
  let environment = EMPTY_LEXICAL_ENVIRONMENT
  const declarations = parse(PRELUDE).body.flatMap((node) =>
    node.type === 'Sequence' ? node.items : [node],
  )
  for (const declaration of declarations) {
    if (declaration.type !== 'VariableDeclaration' && declaration.type !== 'FunctionDeclaration') {
      throw new TypeError('The Xenpaper prelude may only contain declarations.')
    }
    const evaluated = evaluateDeclaration(declaration, DEFAULT_PITCH_CONTEXT, environment)
    if (evaluated.diagnostics.length) {
      throw new TypeError(`Invalid Xenpaper prelude: ${evaluated.diagnostics[0]!.message}`)
    }
    environment = evaluated.environment
  }
  cachedPreludeEnvironment = environment
  return environment
}

// Persistent environment frames advance after each declaration. The token
// identifies the enclosing lexical scope across those snapshots.
const declarationScopes = new WeakMap<LexicalEnvironment | FunctionDefinition, object>()

export function evaluateDeclaration(
  node: Extract<Expression, { type: 'VariableDeclaration' | 'FunctionDeclaration' }>,
  mapping: PrimeMapping | PitchContext = DEFAULT_PITCH_CONTEXT,
  environment?: LexicalEnvironment,
  declarationScope = (environment && declarationScopes.get(environment)) ?? {},
): { readonly environment: LexicalEnvironment; readonly diagnostics: readonly Diagnostic[] } {
  environment ??= preludeEnvironment()
  if (node.type === 'VariableDeclaration') {
    const evaluated = evaluateExpression(node.value, mapping, environment)
    if (!('value' in evaluated)) return { environment, diagnostics: evaluated.diagnostics }
    const next = extendLexicalEnvironment(environment, {
      variables: new Map([
        [
          node.name.name,
          annotateReference(evaluated.value, {
            location: node.name.location,
            role: 'structural',
          }),
        ],
      ]),
    })
    declarationScopes.set(next, declarationScope)
    return { environment: next, diagnostics: evaluated.diagnostics }
  }
  for (let frame: LexicalEnvironment | undefined = environment; frame; frame = frame.parent) {
    const previous = frame.functions.get(node.name.name)
    if (previous && declarationScopes.get(previous) === declarationScope)
      return {
        environment,
        diagnostics: [
          {
            code: 'XP_DUPLICATE_FUNCTION',
            severity: 'error',
            message: `Function ${node.name.name} is already declared in this scope.`,
            locations: [node.name.location, previous.declaration.name.location],
          },
        ],
      }
  }
  const names = node.parameters.map((parameter) => parameter.name.name)
  const duplicate = names.find((name, index) => names.indexOf(name) !== index)
  if (duplicate) {
    return {
      environment,
      diagnostics: [
        {
          code: 'XP_DUPLICATE_PARAMETER',
          severity: 'error',
          message: `Duplicate parameter ${duplicate}.`,
          locations: node.parameters
            .filter((parameter) => parameter.name.name === duplicate)
            .map((parameter) => parameter.name.location),
        },
      ],
    }
  }
  const firstDefault = node.parameters.findIndex((parameter) => parameter.defaultValue)
  const requiredAfterDefault = node.parameters.find(
    (parameter, index) => firstDefault >= 0 && index > firstDefault && !parameter.defaultValue,
  )
  if (requiredAfterDefault)
    return {
      environment,
      diagnostics: [
        {
          code: 'XP_REQUIRED_PARAMETER_AFTER_DEFAULT',
          severity: 'error',
          message: `Required parameter ${requiredAfterDefault.name.name} cannot follow a defaulted parameter.`,
          locations: [requiredAfterDefault.location],
        },
      ],
    }
  const scalarCoercions = new Set(['ratio', 'pitch', 'integer', 'boolean', 'string', 'record'])
  const supportedCoercion = (coercion: NonNullable<FunctionParameter['coercion']>): boolean => {
    if (scalarCoercions.has(coercion.name)) return !coercion.element
    if (coercion.name === 'container')
      return coercion.element ? supportedCoercion(coercion.element) : true
    return false
  }
  const unsupported = node.parameters.find(
    (parameter) => parameter.coercion && !supportedCoercion(parameter.coercion),
  )
  if (unsupported)
    return {
      environment,
      diagnostics: [
        {
          code: 'XP_UNKNOWN_COERCION',
          severity: 'error',
          message: `Unknown parameter coercion ${unsupported.coercion!.raw}.`,
          locations: [unsupported.location],
        },
      ],
    }
  // Capture before installing the definition: ordinary lexical closures work,
  // while direct and mutual recursion remain unavailable by policy.
  const definition = {
    declaration: node,
    parameters: node.parameters,
    body: node.body,
    environment,
  }
  const next = extendLexicalEnvironment(environment, {
    functions: new Map([[node.name.name, definition]]),
  })
  declarationScopes.set(definition, declarationScope)
  declarationScopes.set(next, declarationScope)
  return { environment: next, diagnostics: [] }
}

function isNumericLiteral(node: Expression): node is NumericLiteralNode {
  return (
    node.type === 'IntegerLiteral' ||
    node.type === 'MonzoLiteral' ||
    node.type === 'DecimalLiteral' ||
    node.type === 'RealLiteral' ||
    node.type === 'RatioLiteral' ||
    node.type === 'QuantityLiteral' ||
    node.type === 'EqualDivisionLiteral'
  )
}

type CallDiagnostics = { readonly diagnostics: readonly Diagnostic[] }

function coerceParameter(
  value: EvaluatedLiteral,
  coercion: FunctionParameter['coercion'],
): EvaluatedLiteral {
  if (!coercion || value.kind === 'undefined') return value
  if (coercion.name === 'container' && coercion.element) {
    if (value.kind !== 'container')
      throw new TypeError(`Value cannot be coerced to ${coercion.raw}.`)
    return {
      ...value,
      values: value.values.map((element) => coerceParameter(element, coercion.element)),
    }
  }
  switch (coercion.name) {
    case 'ratio':
      if (value.kind === 'scalar') return value
      if (value.kind === 'pitchOffset')
        return result('scalar', Value.ratio(value.value), value.origins)
      break
    case 'pitch':
      if (value.kind === 'pitchOffset') return value
      if (value.kind === 'scalar' && value.value.isPositiveExactRatio())
        return {
          ...result('pitchOffset', Value.pitch(value.value), value.origins),
          ...(isPositiveRationalRatio(value.value) && { justIntonation: true }),
        }
      break
    case 'integer': {
      if (value.kind !== 'scalar' || !value.value.dimensions.isDimensionless) break
      const exact = value.value.exactRational()
      if (exact?.d === 1) return value
      break
    }
    case 'container':
      if (value.kind === 'container') return value
      break
    case 'string':
    case 'record':
      if (value.kind === coercion.name) return value
      break
    case 'boolean': {
      if (value.kind !== 'scalar' || !value.value.dimensions.isDimensionless) break
      const exact = value.value.exactRational()
      if (exact?.equals(0) || exact?.equals(1)) return { ...value, boolean: true }
      break
    }
    default:
      throw new TypeError(`Unknown parameter coercion ${coercion.raw}.`)
  }
  throw new TypeError(`Value cannot be coerced to ${coercion.raw}.`)
}

/** Evaluate a user call with the caller's interpretation of its return operand. */
export function evaluateFunctionCall<Result extends CallDiagnostics>(
  node: Extract<Expression, { type: 'CallExpression' }>,
  mapping: PrimeMapping | PitchContext,
  environment: LexicalEnvironment | undefined,
  evaluateReturn: ReturnEvaluator<Result>,
): Result | CallDiagnostics | undefined {
  environment ??= preludeEnvironment()
  const value = lookupBinding(node.callee, environment)
  if (!value) return undefined
  if (!isCallableValue(value))
    return {
      diagnostics: [
        {
          code: 'XP_NOT_CALLABLE',
          severity: 'error',
          message: `${node.callee} is not a function.`,
          locations: [node.location],
        },
      ],
    }
  return evaluateCallable(value, node, node.arguments, mapping, environment, evaluateReturn)
}

function lookupBinding(
  name: string,
  environment: LexicalEnvironment,
): EvaluatedLiteral | undefined {
  for (let scope: LexicalEnvironment | undefined = environment; scope; scope = scope.parent) {
    const definition = scope.functions.get(name)
    if (definition)
      return {
        kind: 'function',
        definition,
        value: new Value(0),
        origins: [{ location: definition.declaration.name.location, role: 'structural' }],
      }
    const value = scope.variables.get(name)
    if (value) return value
  }
}

function evaluateCallable<Result extends CallDiagnostics>(
  callable: CallableValue,
  node: Pick<Extract<Expression, { type: 'CallExpression' }>, 'callee' | 'location'>,
  args: readonly (Expression | EvaluatedLiteral)[],
  mapping: PrimeMapping | PitchContext,
  environment: LexicalEnvironment,
  evaluateReturn: ReturnEvaluator<Result>,
): Result | CallDiagnostics {
  const identity = callable.kind === 'function' ? callable.definition : callable.identity
  const declaration = callable.kind === 'function' ? callable.definition.declaration : undefined
  if (environment.calls.has(identity))
    return {
      diagnostics: [
        {
          code: 'XP_RECURSION',
          severity: 'error',
          message: `Recursive call to ${node.callee}() is prohibited.`,
          locations: [node.location, ...(declaration ? [declaration.name.location] : [])],
        },
      ],
    }
  const [minimumArguments, maximumArguments] = callableArity(callable)
  if (args.length < minimumArguments || args.length > maximumArguments)
    return {
      diagnostics: [
        {
          code: 'XP_ARITY',
          severity: 'error',
          message:
            minimumArguments === maximumArguments
              ? `${node.callee}() expects ${maximumArguments} argument${maximumArguments === 1 ? '' : 's'}, but received ${args.length}.`
              : `${node.callee}() expects ${minimumArguments} to ${maximumArguments} arguments, but received ${args.length}.`,
          locations: [node.location, ...(declaration ? [declaration.location] : [])],
        },
      ],
    }
  const supplied: ExpressionEvaluationResult[] = args.map((argument, index) => {
    if (!('type' in argument)) return { value: argument, diagnostics: [] }
    const coercion =
      callable.kind === 'function' ? callable.definition.parameters[index]?.coercion : undefined
    if (coercion?.name === 'container')
      return containerItems(argument, mapping, environment, coercion)
    if (
      argument.type === 'DegreeLiteral' &&
      !argument.explicit &&
      (coercion?.name === 'ratio' || coercion?.name === 'integer' || coercion?.name === 'boolean')
    )
      return evaluateLiteral({
        type: 'IntegerLiteral',
        value: argument.degree,
        raw: argument.raw,
        location: argument.location,
      })
    return evaluateExpression(argument, mapping, environment)
  })
  const diagnostics = supplied.flatMap((result) => result.diagnostics)
  if (!supplied.every((result) => 'value' in result)) return { diagnostics }
  const calls = new Set(environment.calls).add(identity)
  const functionBudget = environment.functionBudget ?? { remaining: 100_000 }
  if (callable.kind === 'lambda') {
    const variables = new Map(
      callable.parameters.map((name, index) => [name, supplied[index]!.value]),
    )
    const returned = evaluateReturn(
      callable.body,
      extendLexicalEnvironment(callable.environment, {
        variables,
        calls,
        functionBudget,
      }),
      false,
    )
    return { ...returned, diagnostics: [...diagnostics, ...returned.diagnostics] }
  }
  const { definition } = callable
  const bindings: FunctionBindings = new WeakMap()
  let bodyEnvironment = extendLexicalEnvironment(definition.environment, {
    functions: new Map([[definition.declaration.name.name, definition]]),
    calls,
    functionBudget,
  })
  for (const [index, parameter] of definition.parameters.entries()) {
    let evaluated: ExpressionEvaluationResult | undefined = supplied[index]
    if (!evaluated) {
      const defaultValue = parameter.defaultValue
      if (!defaultValue) continue
      evaluated = evaluateExpression(defaultValue, mapping, bodyEnvironment)
      diagnostics.push(...evaluated.diagnostics)
      if (!('value' in evaluated)) return { diagnostics }
    }
    if (!('value' in evaluated)) return { diagnostics }
    let value: EvaluatedLiteral
    try {
      value = coerceParameter(evaluated.value, parameter.coercion)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Parameter coercion failed.'
      const argument = args[index]
      diagnostics.push({
        code: 'XP_PARAMETER_COERCION',
        severity: 'error',
        message: `${parameter.name.name}: ${message}`,
        locations: [
          argument === undefined
            ? parameter.location
            : 'type' in argument
              ? argument.location
              : node.location,
          parameter.location,
        ],
      })
      return { diagnostics }
    }
    const variables = new Map([[parameter.name.name, value]])
    bodyEnvironment = extendLexicalEnvironment(bodyEnvironment, { variables })
    bindings.set(bodyEnvironment, variables)
  }
  const { statements, returnStatement } = definition.body
  const executed = executeFunctionStatements(
    returnStatement ? [...statements, returnStatement] : statements,
    mapping,
    bodyEnvironment,
    bindings,
    functionBudget,
    evaluateReturn,
  )
  diagnostics.push(...executed.diagnostics)
  if (!executed.environment) {
    return {
      diagnostics: diagnostics.map((diagnostic) => ({
        ...diagnostic,
        locations: [node.location, ...diagnostic.locations],
      })),
    }
  }
  const { returned } = executed
  if (!returned) {
    diagnostics.push({
      code: 'XP_MISSING_RETURN',
      severity: 'error',
      message: `Function ${node.callee}() reached the end without ret.`,
      locations: [node.location, definition.body.location],
    })
    return { diagnostics }
  }
  return { ...returned, diagnostics: [...diagnostics, ...returned.diagnostics] }
}

function diagnostic(node: Expression, error: unknown): Diagnostic {
  const message = error instanceof Error ? error.message : 'Invalid expression.'
  let code = 'XP_TYPE_MISMATCH'
  if (message.toLowerCase().includes('division by zero')) code = 'XP_DIVISION_BY_ZERO'
  else if (message.toLowerCase().includes('dimension')) code = 'XP_DIMENSION_MISMATCH'
  return { code, severity: 'error', message, locations: [node.location] }
}

export function stringValue(text: string, origins: readonly SourceOrigin[]): StringValue {
  return { kind: 'string', text, origins, value: new Value(0) }
}

export function evaluateThrow(
  node: Extract<Expression, { type: 'ThrowStatement' }>,
  mapping: PrimeMapping | PitchContext,
  environment: LexicalEnvironment | undefined,
): readonly Diagnostic[] {
  const message = evaluateExpression(node.message, mapping, environment)
  if (!('value' in message)) return message.diagnostics
  return [
    ...message.diagnostics,
    message.value.kind === 'string'
      ? {
          code: 'XP_THROW',
          severity: 'error',
          message: message.value.text,
          locations: [node.location],
        }
      : diagnostic(node.message, new TypeError('throw() requires a string.')),
  ]
}

function booleanValue(value: boolean, origins: readonly SourceOrigin[]): ScalarValue {
  return { ...result('scalar', new Value(value ? 1 : 0), origins), boolean: true }
}

function result(kind: 'scalar', value: Value, origins: readonly SourceOrigin[]): ScalarValue
function result(
  kind: 'pitchOffset',
  value: Value,
  origins: readonly SourceOrigin[],
): PitchOffsetValue
function result(
  kind: 'scalar' | 'pitchOffset',
  value: Value,
  origins: readonly SourceOrigin[],
): ScalarValue | PitchOffsetValue {
  return { kind, value, origins }
}

function operatorOrigins(
  left: EvaluatedLiteral,
  right: EvaluatedLiteral,
  node: Expression,
): readonly SourceOrigin[] {
  return [...left.origins, ...right.origins, { location: node.location, role: 'operator' }]
}

function pitchCoercion(value: EvaluatedLiteral): PitchOffsetValue {
  if (value.kind === 'pitchOffset') return value
  if (value.kind === 'absolutePitch')
    throw new TypeError('An absolute pitch cannot be coerced to a pitch offset.')
  const ratio = value.value.exactRational()
  if (!ratio || ratio.compare(0) <= 0) {
    throw new TypeError('A scalar mixed with a pitch offset must be a positive exact ratio.')
  }
  return result('pitchOffset', Value.pitch(value.value), value.origins)
}

function addOrSubtract(
  left: EvaluatedLiteral,
  right: EvaluatedLiteral,
  subtract: boolean,
  node: Expression,
): EvaluatedLiteral {
  const origins = operatorOrigins(left, right, node)
  if (left.kind === 'absolutePitch' || right.kind === 'absolutePitch') {
    if (left.kind === 'absolutePitch' && right.kind === 'absolutePitch') {
      if (!subtract) throw new TypeError('Absolute pitches cannot be added together.')
      const mos = left.mos?.context
      return {
        kind: 'pitchOffset',
        value: left.rootOffset.sub(right.rootOffset),
        spelling: spellPitchDifference(left, right),
        ...(mos && right.mos?.context === mos && { mosContext: mos }),
        origins,
      }
    }
    if (subtract && left.kind !== 'absolutePitch')
      throw new TypeError('A pitch offset cannot subtract an absolute pitch.')
    const pitch = left.kind === 'absolutePitch' ? left : right
    if (pitch.kind !== 'absolutePitch') throw new TypeError('Expected an absolute pitch.')
    const offset = pitchCoercion(left.kind === 'absolutePitch' ? right : left)
    const spelling = transposePitchSpelling(pitch.spelling, offset.spelling, subtract)
    const rootOffset = subtract
      ? pitch.rootOffset.sub(offset.value)
      : pitch.rootOffset.add(offset.value)
    let mos = pitch.mos
    let mosSpelling
    if (mos && offset.spelling?.raw.endsWith('ms')) {
      const mosContext = mos.context
      const registerSteps = (offset.spelling.modifiers ?? []).reduce(
        (sum, modifier) => sum + modifierEquaveShift(modifier) * mosContext.nominals.size,
        0,
      )
      let steps = Number(offset.spelling.number.valueOf()) + registerSteps
      if (offset.spelling.direction === 'descending') steps = -steps
      if (subtract) steps = -steps
      const rank = mos.rank + steps
      const nominals = [...mos.context.nominals.keys()]
      const nominal = nominals[((rank % nominals.length) + nominals.length) % nominals.length]!
      const registers = Math.floor(rank / nominals.length)
      const modifiers = registers
        ? Array.from({ length: Math.abs(registers) }, () =>
            registers > 0 ? 'equaveUp' : 'equaveDown',
          )
        : undefined
      const naturalOffset = mos.context.nominals
        .get(nominal)!
        .add(mos.context.equave.mul(new Value(registers)))
      const sourceRegister = Math.floor(mos.rank / nominals.length)
      const sourceNominal = nominals[mmod(mos.rank, nominals.length)]!
      const sourceNaturalOffset = mos.context.nominals
        .get(sourceNominal)!
        .add(mos.context.equave.mul(new Value(sourceRegister)))
      const chroma = mos.context.large.sub(mos.context.small).valueOf()
      const sourceHalfAlterations = (pitch.spelling.accidentals ?? []).reduce(
        (sum, token) => sum + (MOS_HALF_ALTERATIONS[token] ?? 0),
        0,
      )
      const intervalAlteration = rootOffset
        .sub(pitch.rootOffset)
        .sub(naturalOffset.sub(sourceNaturalOffset))
      const halfAlterations =
        sourceHalfAlterations +
        (chroma ? Math.round((2 * intervalAlteration.valueOf()) / chroma) : 0)
      const accidental = halfAlterations > 0 ? '&' : '@'
      const halfAccidental = halfAlterations > 0 ? 'e' : 'a'
      const accidentals: string[] = Array.from(
        { length: Math.floor(Math.abs(halfAlterations) / 2) },
        () => accidental,
      )
      if (Math.abs(halfAlterations) % 2) accidentals.push(halfAccidental)
      mos = { ...mos, rank }
      mosSpelling = {
        nominal,
        raw: nominal,
        system: 'mos' as const,
        derived: true,
        accidentals,
        ...(modifiers ? { modifiers } : {}),
      }
    }
    const formula = offset.formula
      ? new Map([...pitch.formula].map(([prime, exponent]) => [prime, new Fraction(exponent)]))
      : undefined
    if (formula && offset.formula) {
      for (const [prime, exponent] of offset.formula) {
        const combined = (formula.get(prime) ?? new Fraction(0)).add(
          subtract ? new Fraction(exponent).neg() : exponent,
        )
        if (combined.n) formula.set(prime, combined)
        else formula.delete(prime)
      }
    }
    return {
      ...pitch,
      rootOffset,
      ...(formula ? { formula } : {}),
      ...(mosSpelling ? { spelling: mosSpelling } : spelling ? { spelling } : {}),
      ...(mos ? { mos } : {}),
      origins,
    }
  }
  if (left.kind === 'pitchOffset' || right.kind === 'pitchOffset') {
    const lhs = pitchCoercion(left)
    const rhs = pitchCoercion(right)
    const value = subtract ? lhs.value.sub(rhs.value) : lhs.value.add(rhs.value)
    if (!lhs.formula || !rhs.formula) return result('pitchOffset', value, origins)
    const formula = new Map(
      [...lhs.formula].map(([prime, exponent]) => [prime, new Fraction(exponent)]),
    )
    for (const [prime, exponent] of rhs.formula) {
      const combined = (formula.get(prime) ?? new Fraction(0)).add(
        subtract ? new Fraction(exponent).neg() : exponent,
      )
      if (combined.n) formula.set(prime, combined)
      else formula.delete(prime)
    }
    return {
      kind: 'pitchOffset',
      value,
      formula,
      spelling: spellIntervalFormula(formula),
      origins,
    }
  }
  return result(
    'scalar',
    subtract ? left.value.sub(right.value) : left.value.add(right.value),
    origins,
  )
}

function multiplyOrDivide(
  left: EvaluatedLiteral,
  right: EvaluatedLiteral,
  divide: boolean,
  node: Expression,
): EvaluatedLiteral {
  if (left.kind === 'absolutePitch' || right.kind === 'absolutePitch')
    throw new TypeError('Absolute pitches cannot be multiplied or divided.')
  if (left.kind === 'pitchOffset' && right.kind === 'pitchOffset') {
    if (divide)
      return result('scalar', left.value.log(right.value), operatorOrigins(left, right, node))
    throw new TypeError('Pitch offsets cannot be multiplied or divided together.')
  }
  if (divide && right.kind === 'pitchOffset') {
    throw new TypeError('A scalar cannot be divided by a pitch offset.')
  }
  if (left.kind === 'pitchOffset' || right.kind === 'pitchOffset') {
    const scalar = left.kind === 'pitchOffset' ? right : left
    const offset = left.kind === 'pitchOffset' ? left : right
    if (scalar.kind !== 'scalar' || offset.kind !== 'pitchOffset')
      throw new TypeError('Pitch offsets require a scalar factor.')
    const factor = scalar.value.exactRational()
    if (!factor) throw new TypeError('Pitch offsets can only be scaled by exact rational scalars.')
    return {
      ...scalePitchOffset(offset, divide ? new Fraction(1).div(factor) : factor),
      origins: operatorOrigins(left, right, node),
    }
  }
  return result(
    'scalar',
    divide ? left.value.div(right.value) : left.value.mul(right.value),
    operatorOrigins(left, right, node),
  )
}

function modulo(
  left: EvaluatedLiteral,
  right: EvaluatedLiteral,
  ceiling: boolean,
  node: Expression,
): EvaluatedLiteral {
  if (left.kind === 'absolutePitch' || right.kind === 'absolutePitch') {
    throw new TypeError('Modulo does not support absolute pitches.')
  }
  const remainder = left.value.mmod(right.value)
  const value = ceiling && remainder.isZero() ? right.value : remainder
  if (left.kind === 'pitchOffset' || right.kind === 'pitchOffset') {
    const difference = addOrSubtract(left, right, true, node)
    if (difference.kind === 'pitchOffset' && difference.value.equals(value)) return difference
    return result('pitchOffset', value, operatorOrigins(left, right, node))
  }
  return result('scalar', value, operatorOrigins(left, right, node))
}

function geometricModulo(
  left: EvaluatedLiteral,
  right: EvaluatedLiteral,
  ceiling: boolean,
  node: Expression,
): EvaluatedLiteral {
  if (left.kind !== 'scalar' || right.kind !== 'scalar') {
    throw new TypeError('Geometric modulo requires ratio operands.')
  }
  const reduced = left.value.reduce(right.value)
  const value = ceiling && reduced.compare(1) === 0 ? right.value : reduced
  return result('scalar', value, operatorOrigins(left, right, node))
}

function logarithmicDivision(
  left: EvaluatedLiteral,
  right: EvaluatedLiteral,
  node: Expression,
): EvaluatedLiteral {
  if (left.kind !== 'scalar' || right.kind !== 'scalar') {
    throw new TypeError('Logarithmic division requires scalar operands.')
  }
  return result('scalar', left.value.log(right.value), operatorOrigins(left, right, node))
}

const comparisons = new Map<string, (order: number, equal: boolean) => boolean>([
  ['@eq', (_order, equal) => equal],
  ['@ne', (_order, equal) => !equal],
  ['@lt', (order) => order < 0],
  ['@le', (order) => order <= 0],
  ['@gt', (order) => order > 0],
  ['@ge', (order) => order >= 0],
])

export const isComparison = (operator: string): boolean => comparisons.has(operator)

function compareOperands(
  node: Extract<Expression, { type: 'BinaryExpression' }>,
  left: EvaluatedLiteral,
  right: EvaluatedLiteral,
): ScalarValue {
  if (left.kind === 'string' && right.kind === 'string') {
    const order = left.text < right.text ? -1 : left.text > right.text ? 1 : 0
    return booleanValue(
      comparisons.get(node.operator)!(order, order === 0),
      operatorOrigins(left, right, node),
    )
  }
  const magnitude = (operand: EvaluatedLiteral): Value => {
    if (operand.kind === 'absolutePitch') return operand.rootOffset
    if (operand.kind === 'scalar' || operand.kind === 'pitchOffset') return operand.value
    throw new TypeError(`Operator ${node.operator} requires numeric or pitch operands.`)
  }
  let lhs = magnitude(left)
  let rhs = magnitude(right)
  // Positive scalars can represent frequency ratios, just as in pitch arithmetic.
  if (lhs.dimensions.equals({ pitch: 1 }) && rhs.isPositiveExactRatio()) rhs = Value.pitch(rhs)
  else if (rhs.dimensions.equals({ pitch: 1 }) && lhs.isPositiveExactRatio()) lhs = Value.pitch(lhs)
  const order = lhs.compare(rhs)
  const equal = lhs.isExact() && rhs.isExact() ? lhs.equals(rhs) : lhs.valueOf() === rhs.valueOf()
  const value = comparisons.get(node.operator)!(order, equal)
  return booleanValue(value, operatorOrigins(left, right, node))
}

export function isTruthy(value: EvaluatedLiteral): boolean {
  if (value.kind === 'undefined') return false
  if (value.kind === 'absolutePitch' || value.kind === 'scoreFragment' || isCallableValue(value))
    return true
  if (value.kind === 'container') return value.values.length > 0
  if (value.kind === 'string') return value.text.length > 0
  if (value.kind === 'record') return value.fields.size > 0
  return !value.value.isZero()
}

function binary(
  operator: string,
  left: EvaluatedLiteral,
  right: EvaluatedLiteral,
  node: Expression,
): EvaluatedLiteral {
  if (operator === '+' && left.kind === 'string' && right.kind === 'string')
    return stringValue(left.text + right.text, operatorOrigins(left, right, node))
  if (left.kind === 'container' || right.kind === 'container') {
    if (left.kind === 'container' && right.kind === 'container') {
      if (left.composition && right.composition && left.composition !== right.composition)
        throw new TypeError('Container operands must have the same composition.')
      if (left.values.length !== right.values.length)
        throw new TypeError('Container operands must have the same length.')
      return {
        ...left,
        values: left.values.map((value, index) =>
          binary(operator, value, right.values[index]!, node),
        ),
      }
    }
    const container = (left.kind === 'container' ? left : right) as Extract<
      EvaluatedLiteral,
      { kind: 'container' }
    >
    const scalar = left.kind === 'container' ? right : left
    return {
      ...container,
      values: container.values.map((value) =>
        left.kind === 'container'
          ? binary(operator, value, scalar, node)
          : binary(operator, scalar, value, node),
      ),
    }
  }
  if (
    left.kind === 'undefined' ||
    right.kind === 'undefined' ||
    isCallableValue(left) ||
    isCallableValue(right) ||
    left.kind === 'scoreFragment' ||
    right.kind === 'scoreFragment' ||
    left.kind === 'string' ||
    right.kind === 'string' ||
    left.kind === 'record' ||
    right.kind === 'record'
  )
    throw new TypeError(`Operator ${operator} requires numeric operands.`)
  switch (operator) {
    case '+':
      return addOrSubtract(left, right, false, node)
    case '-':
      return addOrSubtract(left, right, true, node)
    case '*':
      return multiplyOrDivide(left, right, false, node)
    case '/':
    case 'div':
      return multiplyOrDivide(left, right, true, node)
    case 'mod':
    case 'modc':
      return modulo(left, right, operator === 'modc', node)
    case 'rd':
    case 'rdc':
      return geometricModulo(left, right, operator === 'rdc', node)
    case '/_':
      return logarithmicDivision(left, right, node)
    case '**': {
      if (left.kind !== 'scalar' || right.kind !== 'scalar') {
        throw new TypeError('Exponentiation requires scalar operands.')
      }
      return result('scalar', left.value.pow(right.value), operatorOrigins(left, right, node))
    }
    default:
      throw new TypeError(`Unknown binary operator ${operator}.`)
  }
}

function scalarInteger(value: EvaluatedLiteral, name: string): number {
  return requireInteger(value, name)
}

function containerItems(
  node: Expression,
  mapping: PrimeMapping | PitchContext,
  environment: LexicalEnvironment,
  coercion?: FunctionParameter['coercion'],
): ExpressionEvaluationResult {
  return evaluateBuiltinArgument(node, coercion, environment, (expression, scope = environment) =>
    evaluateExpression(expression, mapping, scope),
  )
}

function pitchOperatorDisplacement(
  context: PitchContext,
  modifier: string,
  mos?: MosContext,
): Value {
  const inflection = requirePitchOperator(
    context,
    modifier === 'up' || modifier === 'down' ? 'up' : 'lift',
    mos,
  )
  return modifier === 'down' || modifier === 'drop' ? inflection.neg() : inflection
}

function resolveScaleDegree(
  degree: number,
  modifiers: readonly string[],
  context: PitchContext,
): Value {
  const degrees = context.degrees
  let pitch = degree
    ? degrees[mmod(degree - 1, degrees.length)]!.add(
        context.degreeEquave.mul(new Value(Math.floor((degree - 1) / degrees.length))),
      )
    : Value.cents(0)
  for (const modifier of modifiers) {
    const shift = modifierEquaveShift(modifier)
    pitch = pitch.add(
      shift
        ? context.degreeEquave.mul(new Value(shift))
        : pitchOperatorDisplacement(context, modifier),
    )
  }
  return pitch
}

/** Keep nested source references and resolve stored degrees in the reader's tuning. */
function annotateReference(
  value: EvaluatedLiteral,
  origin: SourceOrigin,
  mapping?: PrimeMapping | PitchContext,
): EvaluatedLiteral {
  const origins = [...value.origins, origin]
  if (value.kind === 'container')
    return {
      ...value,
      origins,
      values: value.values.map((item) => annotateReference(item, origin, mapping)),
    }
  if (value.kind === 'record')
    return {
      ...value,
      origins,
      fields: new Map(
        [...value.fields].map(([key, item]) => [key, annotateReference(item, origin, mapping)]),
      ),
    }
  if (
    mapping &&
    value.kind === 'pitchOffset' &&
    value.scaleDegree !== undefined &&
    value.degreeModifiers
  ) {
    return {
      ...value,
      origins,
      value: resolveScaleDegree(value.scaleDegree, value.degreeModifiers, pitchContextFor(mapping)),
    }
  }
  return { ...value, origins }
}

/** Capture values from mutable function frames before their assignments can change them. */
function captureScoreEnvironment(environment: LexicalEnvironment): LexicalEnvironment {
  let scope = environment
  const functionFrames: LexicalEnvironment[] = []
  while (scope.functionBudget && scope.parent) {
    functionFrames.push(scope)
    scope = scope.parent
  }
  for (const frame of functionFrames.reverse()) {
    scope = { ...frame, parent: scope, variables: new Map(frame.variables) }
  }
  return scope
}

function pitchContextFor(mapping: PrimeMapping | PitchContext): PitchContext {
  return 'rootPitch' in mapping ? mapping : createPitchContext(mapping)
}

function modifyPitch(
  operand: EvaluatedLiteral,
  node: Extract<Expression, { type: 'PitchModifierExpression' }>,
  mapping: PrimeMapping | PitchContext,
): EvaluatedLiteral {
  if (operand.kind === 'container')
    return { ...operand, values: operand.values.map((item) => modifyPitch(item, node, mapping)) }
  const modifier = node.modifier.kind
  const origins: SourceOrigin[] = [
    ...operand.origins,
    { role: 'operator', location: node.modifier.location },
  ]
  if (
    operand.kind !== 'scalar' &&
    operand.kind !== 'pitchOffset' &&
    operand.kind !== 'absolutePitch'
  )
    throw new TypeError('Pitch modifiers require a numeric operand.')

  const context = pitchContextFor(mapping)
  const registers = modifierEquaveShift(modifier)
  const absoluteMos = operand.kind === 'absolutePitch' ? operand.mos : undefined
  const mos = operand.kind === 'pitchOffset' ? operand.mosContext : absoluteMos?.context
  // Stored MOS pitches and intervals carry their own notation. Degrees and
  // scalar ratios use the current scale, and other absolute pitches map the octave.
  let shift: Value
  if (registers) {
    let equave = mos?.equave ?? context.mos?.equave ?? Value.cents(1200)
    if (
      operand.kind === 'scalar' ||
      (operand.kind === 'pitchOffset' && operand.scaleDegree !== undefined)
    )
      equave = context.degreeEquave
    else if (operand.kind === 'absolutePitch' && !absoluteMos) equave = context.mapping.mapPrime(2)
    shift = equave.mul(new Value(registers))
  } else shift = pitchOperatorDisplacement(context, modifier, mos)
  if (operand.kind === 'scalar')
    return result('scalar', operand.value.mul(Value.ratio(shift)), origins)

  let formula = operand.formula
  if (formula && registers) {
    const shifted = new Map(formula)
    const writtenShift =
      operand.kind === 'absolutePitch' && !absoluteMos ? Value.cents(1200 * registers) : shift
    for (const [prime, power] of writtenShift.primeExponents() ?? [])
      shifted.set(prime, (shifted.get(prime) ?? new Fraction(0)).add(power))
    formula = shifted
  }
  const modifiers = [modifier, ...(operand.spelling?.modifiers ?? [])]
  if (operand.kind === 'absolutePitch')
    return {
      ...operand,
      rootOffset: operand.rootOffset.add(shift),
      formula: formula!,
      spelling: { ...operand.spelling, modifiers },
      ...(absoluteMos && registers
        ? {
            mos: {
              ...absoluteMos,
              rank: absoluteMos.rank + registers * absoluteMos.context.nominals.size,
            },
          }
        : {}),
      origins,
    }
  return {
    ...operand,
    value: operand.value.add(shift),
    ...(formula && { formula }),
    origins,
    ...(operand.spelling && { spelling: { ...operand.spelling, modifiers } }),
    ...(operand.degreeModifiers && { degreeModifiers: [...operand.degreeModifiers, modifier] }),
  }
}

function applyUnary(
  node: Extract<Expression, { type: 'UnaryExpression' }>,
  operand: EvaluatedLiteral,
  mapping: PrimeMapping | PitchContext,
): EvaluatedLiteral {
  const { operator } = node
  if (operand.kind === 'container' && operator !== '@not')
    return { ...operand, values: operand.values.map((item) => applyUnary(node, item, mapping)) }
  const origins: SourceOrigin[] = [
    ...operand.origins,
    { location: node.location, role: 'operator' },
  ]
  if (operator === '@not') return booleanValue(!isTruthy(operand), origins)
  if (
    operand.kind !== 'scalar' &&
    operand.kind !== 'pitchOffset' &&
    operand.kind !== 'absolutePitch'
  )
    throw new TypeError('Unary operators require a numeric operand.')
  switch (operator) {
    case '+':
      return operand
    case '√':
      if (operand.kind !== 'scalar') throw new TypeError('Square root requires a scalar operand.')
      return result('scalar', operand.value.pow(new Fraction(1, 2)), origins)
    case '~': {
      if (operand.kind === 'pitchOffset') return operand
      if (operand.kind === 'absolutePitch')
        throw new TypeError('An absolute pitch cannot be tempered.')
      if (!operand.value.isPositiveExactRatio())
        throw new TypeError('Tempering requires a positive exact ratio.')
      const formula = operand.value.primeExponents()!
      return {
        kind: 'pitchOffset',
        value: mapFormula(formula, pitchContextFor(mapping).mapping),
        formula,
        spelling: spellIntervalFormula(formula),
        origins,
      }
    }
    case '-': {
      if (operand.kind === 'absolutePitch')
        throw new TypeError('An absolute pitch cannot be negated.')
      if (operand.kind === 'scalar') return result('scalar', operand.value.neg(), origins)
      const { spelling } = operand
      return {
        ...scalePitchOffset(operand, new Fraction(-1)),
        origins,
        spelling: spelling && {
          ...spelling,
          direction: spelling.direction === 'descending' ? 'ascending' : 'descending',
          inflections: spelling.inflections?.map((inflection) => ({
            ...inflection,
            direction: inflection.direction === 'numerator' ? 'denominator' : 'numerator',
          })),
        },
      }
    }
    default:
      throw new TypeError(`Unknown unary operator ${operator}.`)
  }
}

function indexedValue(collection: EvaluatedLiteral, index: EvaluatedLiteral): EvaluatedLiteral {
  if (collection.kind === 'record') {
    if (index.kind !== 'string') throw new TypeError('Record keys must be strings.')
    const value = collection.fields.get(index.text)
    if (!value) throw new RangeError(`Record has no field ${JSON.stringify(index.text)}.`)
    return value
  }
  if (collection.kind !== 'container' && collection.kind !== 'string')
    throw new TypeError('Indexing requires a container, record, or string.')
  const label = collection.kind === 'string' ? 'String index' : 'Container index'
  const offset = scalarInteger(index, label)
  if (collection.kind === 'string') {
    const point = Array.from(collection.text).at(offset)
    if (point !== undefined) return stringValue(point, [...collection.origins, ...index.origins])
  } else {
    const item = collection.values.at(offset)
    if (item) return item
  }
  throw new RangeError(`${label} is out of range.`)
}

/** Evaluate in the supplied lexical and pitch context, retaining source-located diagnostics. */
export function evaluateExpression(
  node: Expression,
  mapping: PrimeMapping | PitchContext = DEFAULT_PITCH_CONTEXT,
  environment: LexicalEnvironment = preludeEnvironment(),
): ExpressionEvaluationResult {
  const evaluate = (expression: Expression, scope = environment) =>
    evaluateExpression(expression, mapping, scope)
  const origins: SourceOrigin[] = [{ location: node.location, role: 'literal' }]
  const diagnostics: Diagnostic[] = []
  const done = (value: EvaluatedLiteral) => ({ value, diagnostics })
  function read(expression: Expression) {
    const evaluated = evaluate(expression)
    if (!('value' in evaluated)) throw new EvaluationError(evaluated.diagnostics)
    diagnostics.push(...evaluated.diagnostics)
    return evaluated.value
  }
  try {
    if (isNumericLiteral(node)) {
      if (node.type === 'EqualDivisionLiteral' && node.equave) {
        const equave = read(node.equave)
        if (equave.kind !== 'scalar')
          throw new TypeError('Equal-division equave must be a scalar ratio.')
        const literal = evaluateLiteral(node, equave.value)
        return { ...literal, diagnostics: [...diagnostics, ...literal.diagnostics] }
      }
      return evaluateLiteral(node)
    }
    if (needsScorePlayback(node))
      return done({
        kind: 'scoreFragment',
        expression: node,
        environment: captureScoreEnvironment(environment),
        value: new Value(0),
        origins: [{ location: node.location, role: 'structural' }],
      })
    switch (node.type) {
      case 'PitchLiteral':
        return done(evaluatePitchLiteral(node, mapping))
      case 'IntervalLiteral':
        return done(evaluateIntervalLiteral(node, mapping))
      case 'MosIntervalLiteral':
        return done(evaluateMosIntervalLiteral(node, mapping))
      case 'DegreeLiteral': {
        const degree = Number(node.degree)
        const modifiers = node.modifiers.map((modifier) => modifier.kind)
        return done({
          kind: 'pitchOffset',
          scaleDegree: degree,
          degreeModifiers: modifiers,
          value: resolveScaleDegree(degree, modifiers, pitchContextFor(mapping)),
          origins,
        })
      }
      case 'StringLiteral':
        return done(stringValue(node.value, origins))
      case 'Identifier': {
        const binding = lookupBinding(node.name, environment)
        if (binding) return done(annotateReference(binding, origins[0]!, mapping))
        if (node.name === 'true' || node.name === 'false')
          return done(booleanValue(node.name === 'true', origins))
        if (node.name === 'niente') return done({ kind: 'undefined', value: new Value(0), origins })
        return {
          diagnostics: [
            {
              code: 'XP_UNDEFINED_NAME',
              severity: 'error',
              message: `Undefined name ${node.name}.`,
              locations: [node.location],
            },
          ],
        }
      }
      case 'PostfixExpression':
      case 'Group':
      case 'NormalizeToSlot':
      case 'Parallel':
      case 'Sequence':
        return containerItems(node, mapping, environment)
      case 'RecordLiteral': {
        const fields = new Map<string, EvaluatedLiteral>()
        for (const { key, value } of node.entries) {
          if (fields.has(key.value))
            throw new TypeError(`Duplicate record key ${JSON.stringify(key.value)}.`)
          fields.set(key.value, read(value))
        }
        return done({ kind: 'record', fields, value: new Value(0), origins })
      }
      case 'IndexExpression': {
        const collection = evaluate(node.container)
        const index = evaluate(node.index)
        diagnostics.push(...collection.diagnostics, ...index.diagnostics)
        if (!('value' in collection && 'value' in index)) return { diagnostics }
        return done(indexedValue(collection.value, index.value))
      }
      case 'EnumeratedChord': {
        const expanded = expandHarmonicSegment(node, evaluate)
        const members = expanded.expressions.map((expression) => evaluate(expression))
        diagnostics.push(
          ...expanded.diagnostics,
          ...members.flatMap((member) => member.diagnostics),
        )
        if (
          expanded.diagnostics.some(({ severity }) => severity === 'error') ||
          !members.every((member) => 'value' in member)
        )
          return { diagnostics }
        return done({
          kind: 'container',
          composition: 'parallel',
          values: members.map((member) => member.value),
          value: new Value(0),
          origins,
        })
      }
      case 'LambdaExpression': {
        const parameters = node.parameters.map((parameter) => parameter.name)
        if (new Set(parameters).size !== parameters.length)
          throw new TypeError('Lambda parameters must be unique.')
        return done({
          kind: 'lambda',
          identity: Symbol(),
          parameters,
          body: node.body,
          environment,
          value: new Value(0),
          origins,
        })
      }
      case 'CallExpression': {
        const called = evaluateFunctionCall(node, mapping, environment, evaluate)
        if (called) return called
        return evaluateBuiltinCall(node, environment, evaluate, (callable, args) =>
          evaluateCallable(
            callable,
            {
              callee:
                callable.kind === 'function' ? callable.definition.declaration.name.name : 'lambda',
              location: node.location,
            },
            args,
            mapping,
            environment,
            evaluate,
          ),
        )
      }
      case 'ConditionalExpression':
        return done(read(isTruthy(read(node.condition)) ? node.consequent : node.alternate))
      case 'PitchModifierExpression':
        return done(modifyPitch(read(node.operand), node, mapping))
      case 'UnaryExpression':
        return done(applyUnary(node, read(node.operand), mapping))
      case 'BinaryExpression': {
        const left = read(node.left)
        if (node.operator === 'al') return done(left.kind === 'undefined' ? read(node.right) : left)
        if (node.operator === '@and' || node.operator === '@or')
          return done(isTruthy(left) === (node.operator === '@or') ? left : read(node.right))
        const right = read(node.right)
        return done(
          isComparison(node.operator)
            ? compareOperands(node, left, right)
            : binary(node.operator, left, right, node),
        )
      }
      default:
        throw new TypeError(`${node.type} is not an arithmetic expression.`)
    }
  } catch (error) {
    return {
      diagnostics: [
        ...diagnostics,
        ...(error instanceof EvaluationError ? error.diagnostics : [diagnostic(node, error)]),
      ],
    }
  }
}
