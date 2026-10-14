// AST call collection for TypeScript sequence generation.
//
// Pure visitor (no filesystem, no type resolution): named functions,
// variable-bound arrow/function expressions, and class methods become
// operations, and every static call site becomes an ordered edge. Only the
// passed compiler module is used, so installs without `typescript` keep
// working on the regex fallback.

import type { CallEdge } from "../sequence/callGraph.js";
import type { TsModule } from "./tsParse.js";
import type * as tsTypes from "typescript";

/** Ordered calls plus the callable names this file declares. */
export interface TsCallAnalysis {
  /** One edge per static call site, in callee-token order. */
  edges: CallEdge[];
  /** Named functions, variable-bound arrows/functions, class methods. */
  operations: Set<string>;
}

/** Wrappers whose own call schedules work rather than sequencing it. */
const CALLBACK_WRAPPER_NAMES = new Set([
  "setTimeout",
  "setInterval",
  "setImmediate",
  "nextTick",
  "then",
  "catch",
  "finally",
  "on",
  "once",
  "addEventListener",
  "addListener",
  "subscribe",
  "emit",
]);

const TOP_LEVEL_CALLER = "<module>";

function isBareIdentifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name);
}

/** Method/property name text; "" for computed or non-identifier shapes. */
function operationNameText(ts: TsModule, name: tsTypes.PropertyName): string {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return isBareIdentifier(name.text) ? name.text : "";
  }
  return "";
}

function unwrapExpression(ts: TsModule, expression: tsTypes.Expression): tsTypes.Expression {
  let current = expression;
  for (;;) {
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

function isFunctionInitializer(ts: TsModule, expression: tsTypes.Expression): boolean {
  const unwrapped = unwrapExpression(ts, expression);
  return ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped);
}

/** Static callee name plus the callee token position that orders edges. */
function calleeNameAndPos(
  ts: TsModule,
  call: tsTypes.CallExpression,
  sourceFile: tsTypes.SourceFile,
): { name: string; pos: number } | null {
  const target = unwrapExpression(ts, call.expression);
  if (ts.isIdentifier(target)) {
    return { name: target.text, pos: target.getStart(sourceFile) };
  }
  if (ts.isPropertyAccessExpression(target) && ts.isIdentifier(target.name)) {
    return { name: target.name.text, pos: target.name.getStart(sourceFile) };
  }
  if (ts.isElementAccessExpression(target)) {
    const argument = target.argumentExpression;
    if (
      argument &&
      (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) &&
      isBareIdentifier(argument.text)
    ) {
      return { name: argument.text, pos: argument.getStart(sourceFile) };
    }
  }
  return null;
}

interface CallContext {
  caller: string;
  deferred: boolean;
  inCallArgument: boolean;
}

interface RawEdge extends CallEdge {
  pos: number;
}

/**
 * Collect ordered call edges and operation names from a parsed source file.
 * `ts` is the pre-resolved compiler; invalid roots produce empty results and
 * unexpected visitor failures propagate.
 */
export function collectTsCalls(sourceFile: unknown, ts: TsModule): TsCallAnalysis {
  const operations = new Set<string>();
  const rawEdges: RawEdge[] = [];
  if (!sourceFile || typeof sourceFile !== "object") return { edges: [], operations };
  const root = sourceFile as tsTypes.SourceFile;
  if (root.kind !== ts.SyntaxKind.SourceFile || !Array.isArray(root.statements)) {
    return { edges: [], operations };
  }

  function visitChildren(node: tsTypes.Node, context: CallContext): void {
    ts.forEachChild(node, (child) => visit(child, context));
  }

  function visitFunction(node: tsTypes.FunctionDeclaration, context: CallContext): void {
    const name = node.name?.text;
    if (name) operations.add(name);
    visitChildren(node, { ...context, caller: name ?? context.caller, inCallArgument: false });
  }

  function visitMethod(
    node: tsTypes.MethodDeclaration | tsTypes.AccessorDeclaration | tsTypes.ConstructorDeclaration,
    context: CallContext,
  ): void {
    const name = ts.isConstructorDeclaration(node)
      ? "constructor"
      : operationNameText(ts, node.name);
    if (name) operations.add(name);
    visitChildren(node, {
      caller: name || context.caller,
      deferred: context.deferred || context.inCallArgument,
      inCallArgument: false,
    });
  }

  function visitBinding(
    node: tsTypes.VariableDeclaration | tsTypes.PropertyDeclaration,
    context: CallContext,
  ): void {
    if (
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isFunctionInitializer(ts, node.initializer)
    ) {
      operations.add(node.name.text);
      visit(node.initializer, { ...context, caller: node.name.text, inCallArgument: false });
    } else {
      visitChildren(node, context);
    }
  }

  function visitCallback(
    node: tsTypes.ArrowFunction | tsTypes.FunctionExpression,
    context: CallContext,
  ): void {
    const name = ts.isFunctionExpression(node) ? node.name?.text : undefined;
    if (name) operations.add(name);
    visitChildren(node, {
      caller: name ?? context.caller,
      deferred: context.deferred || context.inCallArgument,
      inCallArgument: false,
    });
  }

  function visitCall(node: tsTypes.CallExpression, context: CallContext): void {
    const callee = calleeNameAndPos(ts, node, root);
    if (callee) {
      rawEdges.push({
        caller: context.caller,
        callee: callee.name,
        viaCallback: context.deferred || CALLBACK_WRAPPER_NAMES.has(callee.name),
        line: 0,
        pos: callee.pos,
      });
    }
    visit(node.expression, { ...context, inCallArgument: false });
    for (const argument of node.arguments) visit(argument, { ...context, inCallArgument: true });
  }

  function visit(node: tsTypes.Node, context: CallContext): void {
    if (ts.isFunctionDeclaration(node)) return visitFunction(node, context);
    if (
      ts.isConstructorDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)
    )
      return visitMethod(node, context);
    if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node))
      return visitBinding(node, context);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
      return visitCallback(node, context);
    if (ts.isCallExpression(node)) return visitCall(node, context);
    visitChildren(node, context);
  }

  visit(root, { caller: TOP_LEVEL_CALLER, deferred: false, inCallArgument: false });
  rawEdges.sort((a, b) => a.pos - b.pos);
  const edges: CallEdge[] = rawEdges.map((edge) => ({
    caller: edge.caller,
    callee: edge.callee,
    viaCallback: edge.viaCallback,
    line: root.getLineAndCharacterOfPosition(edge.pos).line + 1,
  }));
  return { edges, operations };
}
