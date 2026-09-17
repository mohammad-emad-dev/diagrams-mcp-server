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

function visitHeritage(ts: TsModule, node: tsTypes.Node, edges: HeritageEdge[]): void {
  if (
    (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name) &&
    Array.isArray(node.heritageClauses)
  ) {
    const child = node.name.text;
    for (const clause of node.heritageClauses) {
      const kind: HeritageEdge["kind"] | null =
        clause.token === ts.SyntaxKind.ExtendsKeyword
          ? "extends"
          : clause.token === ts.SyntaxKind.ImplementsKeyword
            ? "implements"
            : null;
      if (kind === null) continue;
      for (const type of clause.types) {
        const parent = heritageTypeName(ts, type.expression);
        if (parent.length > 0) edges.push({ from: child, to: parent, kind });
      }
    }
  }
  ts.forEachChild(node, (child) => visitHeritage(ts, child, edges));
}

/** Collect heritage edges from a parsed source file; never throws. */
export function collectTsHeritage(sourceFile: unknown, ts: TsModule): HeritageEdge[] {
  const edges: HeritageEdge[] = [];
  if (!sourceFile || typeof sourceFile !== "object") return edges;
  const root = sourceFile as tsTypes.SourceFile;
  if (root.kind !== ts.SyntaxKind.SourceFile || !Array.isArray(root.statements)) return edges;
  visitHeritage(ts, root, edges);
  return edges;
}
