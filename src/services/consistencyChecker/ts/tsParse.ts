// TypeScript source parsing behind an isolated compiler boundary.
// Phase 1 stub: signatures only. No caller wires into this yet, so every
// function returns the safe fallback (unavailable / null / empty).

/** True when the TypeScript compiler resolves via dynamic import. */
export async function isTsAstAvailable(): Promise<boolean> {
  try {
    await import("typescript");
    return true;
  } catch {
    return false;
  }
}

/** Parse one source file; null when unavailable or unparseable (stub: always null). */
export async function parseTsSource(_filePath: string, _rawText: string): Promise<unknown> {
  void _filePath;
  void _rawText;
  return null;
}
