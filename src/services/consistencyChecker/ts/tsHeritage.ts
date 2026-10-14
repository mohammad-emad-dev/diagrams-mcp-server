// AST heritage visitor (extends/implements), pure like tsSymbols.ts: no
// filesystem, no type resolution. Collects child -> parent names only.
// Cross-file inheritance through re-exports is deliberately out of scope
// (see docs/next-features.md, diagrams_generate non-goals); the caller
// keeps only edges whose both endpoints are declared in the scanned scope.

import type { TsModule } from "./tsParse.js";
import type * as tsTypes from "typescript";

export interface HeritageEdge {
  /** Declaring class or interface name. */
  from: string;
  /** Parent type name; the last segment when the type is qualified. */
  to: string;
  /** Generalization (extends) or realization (implements). */
  kind: "extends" | "implements";
}

/** Bare name of a heritage type expression; "" for shapes we do not read. */
function heritageTypeName(ts: TsModule, expression: tsTypes.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isQualifiedName(expression)) return expression.right.text;
  return "";
}

function heritageClauseKind(
  ts: TsModule,
  clause: tsTypes.HeritageClause,
): HeritageEdge["kind"] | null {
  if (clause.token === ts.SyntaxKind.ExtendsKeyword) return "extends";
  if (clause.token === ts.SyntaxKind.ImplementsKeyword) return "implements";
  return null;
}

/** Named class/interface parents: one edge per parent type, in clause order. */
function collectNamedHeritage(
  ts: TsModule,
  node: tsTypes.ClassDeclaration | tsTypes.InterfaceDeclaration,
  edges: HeritageEdge[],
): void {
  if (!node.name || !ts.isIdentifier(node.name) || !Array.isArray(node.heritageClauses)) return;
  const child = node.name.text;
  for (const clause of node.heritageClauses) {
    const kind = heritageClauseKind(ts, clause);
    if (kind === null) continue;
    for (const type of clause.types) {
      const parent = heritageTypeName(ts, type.expression);
      if (parent.length > 0) edges.push({ from: child, to: parent, kind });
    }
  }
}

function visitHeritage(ts: TsModule, node: tsTypes.Node, edges: HeritageEdge[]): void {
  if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
    collectNamedHeritage(ts, node, edges);
  }
  ts.forEachChild(node, (child) => visitHeritage(ts, child, edges));
}

/**
 * Collect heritage edges from a parsed source file. Invalid root values
 * produce no edges; unexpected visitor or compiler failures propagate.
 */
export function collectTsHeritage(sourceFile: unknown, ts: TsModule): HeritageEdge[] {
  const edges: HeritageEdge[] = [];
  if (!sourceFile || typeof sourceFile !== "object") return edges;
  const root = sourceFile as tsTypes.SourceFile;
  if (root.kind !== ts.SyntaxKind.SourceFile || !Array.isArray(root.statements)) return edges;
  visitHeritage(ts, root, edges);
  return edges;
}
