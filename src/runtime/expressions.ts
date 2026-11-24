import { parse, type Expression, type FunctionParameter } from '../parser.js'
import { Fraction, mmod } from 'xen-dev-utils/fraction'
import type { Diagnostic } from '../diagnostics.js'
import { Value } from '../value.js'
import { evaluateBuiltinArgument, evaluateBuiltinCall, requireInteger } from './builtins.js'
import { evaluateLiteral, type NumericLiteralNode } from './literals.js'
import { executeFunctionStatements, type FunctionBindings } from './function-statements.js'
import { expandHarmonicSegment } from './harmonic-segments.js'
import { needsScorePlayback } from './score-fragments.js'
import { equaveShift as modifierEquaveShift } from './pitch-modifiers.js'
import type {
  EvaluatedLiteral,
  CallableValue,
  LexicalEnvironment,
  PitchOffsetValue,
  ScalarValue,
  StringValue,
  SourceOrigin,
} from './types.js'
import type { PitchContext, PrimeMapping } from './types.js'
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
fn prod(factors: container) { ret arrayReduce((total, element) => total * ratio(element), factors, 1/1) }
fn ground(scale: container) { ret scale - pitch(scale[0]) }
fn equaveReduce(scale: container, equave: ratio <- niente) {
  let actualEquave <- equave al scale[-1]
  ret ratio(scale) rd ratio(actualEquave)
}
fn cps(factors: container<ratio>, count: integer, equave: ratio <- niente, withUnity: boolean <- false) {
  let products <- sorted(arrayMap((combination) => prod(combination), kCombinations(factors, count)))
  let grounded <- products if (withUnity al false) else ground(products)
  let actualEquave <- equave al (pitch(2/1) + grounded[0])
  ret asSequence(sorted(equaveReduce(grounded, actualEquave)))
}
fn eulerGenus(guide: integer, root: integer <- 1/1, equave: ratio <- 2/1) {
  if(guide @le 0) { throw("Guide tone must be a positive integer.") }
  if(root @le 0) { throw("Root tone must be a positive integer.") }
  if(equave @le 1) { throw("Equave must be greater than one.") }
  if(guide mod root) { throw("Root must divide the guide tone.") }
  while(@not (guide mod equave)) {
    guide <- guide / equave
  }
  let pitches <- [equave]
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

export function evaluateDeclaration(
  node: Extract<Expression, { type: 'VariableDeclaration' | 'FunctionDeclaration' }>,
  mapping: PrimeMapping | PitchContext = DEFAULT_PITCH_CONTEXT,
  environment: LexicalEnvironment = preludeEnvironment(),
): { readonly environment: LexicalEnvironment; readonly diagnostics: readonly Diagnostic[] } {
  if (node.type === 'VariableDeclaration') {
    const evaluated = evaluateExpression(node.value, mapping, environment)
    if (!('value' in evaluated)) return { environment, diagnostics: evaluated.diagnostics }
    return {
      environment: extendLexicalEnvironment(environment, {
        variables: new Map([
          [
            node.name.name,
            annotateReference(evaluated.value, {
              location: node.name.location,
              role: 'structural',
            }),
          ],
        ]),
      }),
      diagnostics: evaluated.diagnostics,
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
  return {
    environment: extendLexicalEnvironment(environment, {
      functions: new Map([[node.name.name, definition]]),
    }),
    diagnostics: [],
  }
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

export type FunctionCallPreparation =
  | {
      readonly expression: Expression
      readonly environment: LexicalEnvironment
      readonly diagnostics: readonly Diagnostic[]
    }
  | { readonly diagnostics: readonly Diagnostic[] }

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
          justIntonation: true,
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

/** Prepare a user function once; score and scalar consumers evaluate its returned AST themselves. */
export function prepareFunctionCall(
  node: Extract<Expression, { type: 'CallExpression' }>,
  mapping: PrimeMapping | PitchContext = DEFAULT_PITCH_CONTEXT,
  environment: LexicalEnvironment = preludeEnvironment(),
): FunctionCallPreparation | undefined {
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
  return prepareCallable(value, node, node.arguments, mapping, environment)
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

function prepareCallable(
  callable: CallableValue,
  node: Pick<Extract<Expression, { type: 'CallExpression' }>, 'callee' | 'location'>,
  args: readonly (Expression | EvaluatedLiteral)[],
  mapping: PrimeMapping | PitchContext,
  environment: LexicalEnvironment,
): FunctionCallPreparation {
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
    return {
      expression: callable.body,
      environment: extendLexicalEnvironment(callable.environment, {
        variables,
        calls,
        functionBudget,
      }),
      diagnostics,
    }
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
  const executed = executeFunctionStatements(
    definition.body.statements,
    mapping,
    bodyEnvironment,
    bindings,
    functionBudget,
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
  const returned = executed.returned ?? definition.body.returnStatement
  if (!returned) {
    diagnostics.push({
      code: 'XP_MISSING_RETURN',
      severity: 'error',
      message: `Function ${node.callee}() reached the end without ret.`,
      locations: [node.location, definition.body.location],
    })
    return { diagnostics }
  }
  return {
    expression: returned.value,
    environment: executed.environment,
    diagnostics,
  }
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
      return {
        kind: 'pitchOffset',
        value: left.rootOffset.sub(right.rootOffset),
        spelling: spellPitchDifference(left, right),
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
  node: Expression,
): EvaluatedLiteral {
  if (left.kind === 'absolutePitch' || right.kind === 'absolutePitch') {
    throw new TypeError('Modulo does not support absolute pitches.')
  }
  const value = left.value.mmod(right.value)
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
  node: Expression,
): EvaluatedLiteral {
  if (left.kind !== 'scalar' || right.kind !== 'scalar') {
    throw new TypeError('Geometric modulo requires ratio operands.')
  }
  return result('scalar', left.value.reduce(right.value), operatorOrigins(left, right, node))
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
  if (operator === 'al') return left.kind === 'undefined' ? right : left
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
      values: container.values.map((value) => {
        const reduced =
          left.kind === 'container'
            ? binary(operator, value, scalar, node)
            : binary(operator, scalar, value, node)
        if (
          operator === 'rd' &&
          reduced.kind === 'scalar' &&
          reduced.value.equals(new Value(1)) &&
          scalar.kind === 'scalar'
        )
          return scalar
        return reduced
      }),
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
      return modulo(left, right, node)
    case 'rd':
      return geometricModulo(left, right, node)
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

function pitchOperatorDisplacement(context: PitchContext, modifier: string): Value {
  const inflection = requirePitchOperator(
    context,
    modifier === 'up' || modifier === 'down' ? 'up' : 'lift',
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
    const context = 'rootPitch' in mapping ? mapping : createPitchContext(mapping)
    return {
      ...value,
      origins,
      value: resolveScaleDegree(value.scaleDegree, value.degreeModifiers, context),
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

/** Evaluate a value or capture score syntax without throwing for source errors. */
export function evaluateExpression(
  node: Expression,
  mapping: PrimeMapping | PitchContext = DEFAULT_PITCH_CONTEXT,
  environment: LexicalEnvironment = preludeEnvironment(),
): ExpressionEvaluationResult {
  try {
    if (node.type === 'StringLiteral')
      return {
        value: stringValue(node.value, [{ location: node.location, role: 'literal' }]),
        diagnostics: [],
      }
    if (node.type === 'RecordLiteral') {
      const fields = new Map<string, EvaluatedLiteral>()
      const diagnostics: Diagnostic[] = []
      for (const entry of node.entries) {
        const key = entry.key.value
        if (fields.has(key)) throw new TypeError(`Duplicate record key ${JSON.stringify(key)}.`)
        const field = evaluateExpression(entry.value, mapping, environment)
        diagnostics.push(...field.diagnostics)
        if (!('value' in field)) return { diagnostics }
        fields.set(key, field.value)
      }
      return {
        value: {
          kind: 'record',
          fields,
          value: new Value(0),
          origins: [{ location: node.location, role: 'literal' }],
        },
        diagnostics,
      }
    }
    if (needsScorePlayback(node)) {
      return {
        value: {
          kind: 'scoreFragment',
          expression: node,
          environment: captureScoreEnvironment(environment),
          value: new Value(0),
          origins: [{ location: node.location, role: 'structural' }],
        },
        diagnostics: [],
      }
    }
    if (node.type === 'DegreeLiteral') {
      const context = 'rootPitch' in mapping ? mapping : createPitchContext(mapping)
      const degree = Number(node.degree)
      const modifiers = node.modifiers.map((modifier) => modifier.kind)
      const value = resolveScaleDegree(degree, modifiers, context)
      return {
        value: {
          ...result('pitchOffset', value, [{ location: node.location, role: 'literal' }]),
          scaleDegree: degree,
          degreeModifiers: modifiers,
        },
        diagnostics: [],
      }
    }
    if (isNumericLiteral(node)) {
      if (node.type === 'EqualDivisionLiteral' && node.equave) {
        const equave = evaluateExpression(node.equave, mapping, environment)
        if (!('value' in equave)) return equave
        if (equave.value.kind !== 'scalar') {
          throw new TypeError('Equal-division equave must be a scalar ratio.')
        }
        return evaluateLiteral(node, equave.value.value)
      }
      return evaluateLiteral(node)
    }
    if (node.type === 'EnumeratedChord') {
      const expanded = expandHarmonicSegment(node, (endpoint) =>
        evaluateExpression(endpoint, mapping, environment),
      )
      if (!expanded.expressions.length) return { diagnostics: expanded.diagnostics }
      const evaluated = expanded.expressions.map((expression) =>
        evaluateExpression(expression, mapping, environment),
      )
      const diagnostics = [
        ...expanded.diagnostics,
        ...evaluated.flatMap((item) => item.diagnostics),
      ]
      if (!evaluated.every((item) => 'value' in item)) return { diagnostics }
      return {
        value: {
          kind: 'container',
          composition: 'parallel',
          values: evaluated.map((item) => item.value),
          value: new Value(0),
          origins: [{ location: node.location, role: 'literal' }],
        },
        diagnostics,
      }
    }
    if (node.type === 'PitchLiteral')
      return { value: evaluatePitchLiteral(node, mapping), diagnostics: [] }
    if (node.type === 'IntervalLiteral')
      return { value: evaluateIntervalLiteral(node, mapping), diagnostics: [] }
    if (node.type === 'MosIntervalLiteral')
      return { value: evaluateMosIntervalLiteral(node, mapping), diagnostics: [] }
    if (node.type === 'Identifier') {
      const value = lookupBinding(node.name, environment)
      if (value)
        return {
          value: annotateReference(value, { location: node.location, role: 'literal' }, mapping),
          diagnostics: [],
        }
    }
    if (node.type === 'Identifier' && node.name === 'niente')
      return {
        value: {
          kind: 'undefined',
          value: new Value(0),
          origins: [{ location: node.location, role: 'literal' }],
        },
        diagnostics: [],
      }
    if (node.type === 'Identifier' && (node.name === 'true' || node.name === 'false'))
      return {
        value: {
          ...result('scalar', new Value(node.name === 'true' ? 1 : 0), [
            { location: node.location, role: 'literal' },
          ]),
          boolean: true,
        },
        diagnostics: [],
      }
    if (node.type === 'LambdaExpression') {
      const parameters = node.parameters.map((parameter) => parameter.name)
      if (new Set(parameters).size !== parameters.length)
        throw new TypeError('Lambda parameters must be unique.')
      return {
        value: {
          kind: 'lambda',
          identity: Symbol(),
          parameters,
          body: node.body,
          environment,
          value: new Value(0),
          origins: [{ location: node.location, role: 'literal' }],
        },
        diagnostics: [],
      }
    }
    if (node.type === 'Identifier')
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
    if (
      node.type === 'Group' ||
      node.type === 'NormalizeToSlot' ||
      node.type === 'Sequence' ||
      node.type === 'Parallel' ||
      node.type === 'PostfixExpression'
    )
      return containerItems(node, mapping, environment)
    if (node.type === 'PitchModifierExpression') {
      const operand = evaluateExpression(node.operand, mapping, environment)
      if (!('value' in operand)) return operand
      if (
        operand.value.kind === 'container' ||
        operand.value.kind === 'undefined' ||
        isCallableValue(operand.value) ||
        operand.value.kind === 'scoreFragment' ||
        operand.value.kind === 'string' ||
        operand.value.kind === 'record'
      )
        throw new TypeError('Pitch modifiers require a numeric operand.')
      const context = 'rootPitch' in mapping ? mapping : createPitchContext(mapping)
      const modifier = node.modifier.kind
      const equaveShift = modifierEquaveShift(modifier)
      // A MOS equave governs MOS pitches and scale-relative values. Latin and
      // Greek pitches retain their notational octave even while a MOS is active.
      let scalarDisplacement: Value
      let pitchDisplacement: Value
      if (equaveShift) {
        scalarDisplacement = context.degreeEquave.mul(new Value(equaveShift))
        if (operand.value.kind === 'absolutePitch')
          pitchDisplacement =
            context.mos && operand.value.spelling.system === 'mos'
              ? context.mos.equave.mul(new Value(equaveShift))
              : context.mapping.mapPrime(2).mul(new Value(equaveShift))
        else if ('scaleDegree' in operand.value)
          pitchDisplacement = context.degreeEquave.mul(new Value(equaveShift))
        else
          pitchDisplacement = context.mos
            ? context.mos.equave.mul(new Value(equaveShift))
            : Value.pitch(new Value(2).pow(equaveShift))
      } else {
        const inflection = pitchOperatorDisplacement(context, modifier)
        scalarDisplacement = inflection
        pitchDisplacement = inflection
      }
      const operatorOrigin: SourceOrigin = { location: node.modifier.location, role: 'operator' }
      const origins = [...operand.value.origins, operatorOrigin]
      const equaveFormula = equaveShift
        ? operand.value.kind === 'absolutePitch' && operand.value.spelling.system !== 'mos'
          ? new Map([[2, new Fraction(equaveShift)]])
          : Value.ratio(pitchDisplacement).primeExponents()
        : undefined
      const shiftedFormula = (formula: ReadonlyMap<number, Fraction>) => {
        if (!equaveFormula) return formula
        const shifted = new Map(formula)
        for (const [prime, exponent] of equaveFormula) {
          shifted.set(prime, (shifted.get(prime) ?? new Fraction(0)).add(exponent))
        }
        return shifted
      }
      if (operand.value.kind === 'scalar') {
        return {
          value: result(
            'scalar',
            operand.value.value.mul(Value.ratio(scalarDisplacement)),
            origins,
          ),
          diagnostics: operand.diagnostics,
        }
      }
      if (operand.value.kind === 'absolutePitch') {
        return {
          value: {
            ...operand.value,
            origins,
            rootOffset: operand.value.rootOffset.add(pitchDisplacement),
            formula: shiftedFormula(operand.value.formula),
            spelling: {
              ...operand.value.spelling,
              modifiers: [modifier, ...(operand.value.spelling.modifiers ?? [])],
            },
          },
          diagnostics: operand.diagnostics,
        }
      }
      const offset =
        operand.value.kind === 'pitchOffset' ? operand.value : pitchCoercion(operand.value)
      return {
        value: {
          ...offset,
          origins,
          value: offset.value.add(pitchDisplacement),
          ...(offset.degreeModifiers
            ? { degreeModifiers: [...offset.degreeModifiers, modifier] }
            : {}),
          ...(offset.formula ? { formula: shiftedFormula(offset.formula) } : {}),
          ...(offset.spelling
            ? {
                spelling: {
                  ...offset.spelling,
                  modifiers: [modifier, ...(offset.spelling.modifiers ?? [])],
                },
              }
            : {}),
        },
        diagnostics: operand.diagnostics,
      }
    }
    if (node.type === 'UnaryExpression') {
      const operand = evaluateExpression(node.operand, mapping, environment)
      if (!('value' in operand)) return operand
      if (node.operator === '@not')
        return {
          value: {
            ...result('scalar', new Value(isTruthy(operand.value) ? 0 : 1), [
              ...operand.value.origins,
              { location: node.location, role: 'operator' },
            ]),
            boolean: true,
          },
          diagnostics: operand.diagnostics,
        }
      if (
        operand.value.kind === 'container' ||
        operand.value.kind === 'undefined' ||
        isCallableValue(operand.value) ||
        operand.value.kind === 'scoreFragment' ||
        operand.value.kind === 'string' ||
        operand.value.kind === 'record'
      )
        throw new TypeError('Unary operators require a numeric operand.')
      if (node.operator === '+') return operand
      if (node.operator === '√') {
        if (operand.value.kind !== 'scalar')
          throw new TypeError('Square root requires a scalar operand.')
        return {
          value: result('scalar', operand.value.value.pow(new Fraction(1, 2)), [
            ...operand.value.origins,
            { location: node.location, role: 'operator' },
          ]),
          diagnostics: operand.diagnostics,
        }
      }
      if (node.operator === '~') {
        if (operand.value.kind === 'absolutePitch')
          throw new TypeError('An absolute pitch cannot be tempered.')
        if (operand.value.kind === 'pitchOffset') return operand
        const ratio = operand.value.value
        if (!ratio.isPositiveExactRatio())
          throw new TypeError('Tempering requires a positive exact ratio.')
        const formula = ratio.primeExponents()!
        const context = 'rootPitch' in mapping ? mapping : createPitchContext(mapping)
        return {
          value: {
            kind: 'pitchOffset',
            value: mapFormula(formula, context.mapping),
            formula,
            spelling: spellIntervalFormula(formula),
            origins: [
              ...operand.value.origins,
              { location: node.location, role: 'operator' as const },
            ],
          },
          diagnostics: operand.diagnostics,
        }
      }
      if (node.operator !== '-') throw new TypeError(`Unknown unary operator ${node.operator}.`)
      if (operand.value.kind === 'absolutePitch')
        throw new TypeError('An absolute pitch cannot be negated.')
      const origins: readonly SourceOrigin[] = [
        ...operand.value.origins,
        { location: node.location, role: 'operator' },
      ]
      return {
        value:
          operand.value.kind === 'scalar'
            ? result('scalar', operand.value.value.neg(), origins)
            : {
                ...operand.value,
                degreeModifiers: undefined,
                value: operand.value.value.neg(),
                formula: operand.value.formula
                  ? new Map(
                      [...operand.value.formula].map(([prime, exponent]) => [
                        prime,
                        new Fraction(exponent).neg(),
                      ]),
                    )
                  : undefined,
                spelling: operand.value.spelling
                  ? {
                      ...operand.value.spelling,
                      direction:
                        operand.value.spelling.direction === 'descending'
                          ? 'ascending'
                          : 'descending',
                      inflections: operand.value.spelling.inflections?.map((inflection) => ({
                        ...inflection,
                        direction:
                          inflection.direction === 'numerator' ? 'denominator' : 'numerator',
                      })),
                    }
                  : undefined,
                origins,
              },
        diagnostics: operand.diagnostics,
      }
    }
    if (node.type === 'BinaryExpression') {
      const left = evaluateExpression(node.left, mapping, environment)
      if (!('value' in left)) return left
      if (node.operator === 'al' && left.value.kind !== 'undefined') return left
      const logical = node.operator === '@and' || node.operator === '@or'
      if (logical) {
        const truth = isTruthy(left.value)
        if (truth === (node.operator === '@or'))
          return {
            value: booleanValue(truth, [
              ...left.value.origins,
              { location: node.location, role: 'operator' },
            ]),
            diagnostics: left.diagnostics,
          }
      }
      const right = evaluateExpression(node.right, mapping, environment)
      const diagnostics = [...left.diagnostics, ...right.diagnostics]
      if (!('value' in right)) return { diagnostics }
      const value = logical
        ? booleanValue(isTruthy(right.value), operatorOrigins(left.value, right.value, node))
        : isComparison(node.operator)
          ? compareOperands(node, left.value, right.value)
          : binary(node.operator, left.value, right.value, node)
      return { value, diagnostics }
    }
    if (node.type === 'IndexExpression') {
      const container = evaluateExpression(node.container, mapping, environment)
      const index = evaluateExpression(node.index, mapping, environment)
      const diagnostics = [...container.diagnostics, ...index.diagnostics]
      if (!('value' in container) || !('value' in index)) return { diagnostics }
      if (container.value.kind === 'record') {
        if (index.value.kind !== 'string') throw new TypeError('Record keys must be strings.')
        const value = container.value.fields.get(index.value.text)
        if (!value) throw new RangeError(`Record has no field ${JSON.stringify(index.value.text)}.`)
        return { value, diagnostics }
      }
      if (container.value.kind === 'string') {
        const characters = Array.from(container.value.text)
        const offset = scalarInteger(index.value, 'String index')
        const character = characters.at(offset)
        if (character === undefined) throw new RangeError('String index is out of range.')
        return {
          value: stringValue(character, [...container.value.origins, ...index.value.origins]),
          diagnostics,
        }
      }
      if (container.value.kind !== 'container')
        throw new TypeError('Indexing requires a container, record, or string.')
      const offset = scalarInteger(index.value, 'Container index')
      const value =
        container.value.values[offset < 0 ? container.value.values.length + offset : offset]
      if (!value) throw new RangeError('Container index is out of range.')
      return { value, diagnostics }
    }
    if (node.type === 'ConditionalExpression') {
      const condition = evaluateExpression(node.condition, mapping, environment)
      if (!('value' in condition)) return condition
      const branch = evaluateExpression(
        isTruthy(condition.value) ? node.consequent : node.alternate,
        mapping,
        environment,
      )
      return { ...branch, diagnostics: [...condition.diagnostics, ...branch.diagnostics] }
    }
    if (node.type === 'CallExpression') {
      const evaluatePrepared = (prepared: FunctionCallPreparation): ExpressionEvaluationResult => {
        if (!('expression' in prepared)) return prepared
        const body = evaluateExpression(prepared.expression, mapping, prepared.environment)
        return {
          ...body,
          diagnostics: [...prepared.diagnostics, ...body.diagnostics],
        }
      }
      const prepared = prepareFunctionCall(node, mapping, environment)
      if (prepared) return evaluatePrepared(prepared)
      return evaluateBuiltinCall(
        node,
        environment,
        (expression, scope = environment) => evaluateExpression(expression, mapping, scope),
        (callback, args) =>
          evaluatePrepared(
            prepareCallable(
              callback,
              {
                callee:
                  callback.kind === 'function'
                    ? callback.definition.declaration.name.name
                    : 'lambda',
                location: node.location,
              },
              args,
              mapping,
              environment,
            ),
          ),
      )
    }
    throw new TypeError(`${node.type} is not an arithmetic expression.`)
  } catch (error) {
    return { diagnostics: [diagnostic(node, error)] }
  }
}
