// Renderer domain error. Kept in its own module so the command layer can
// throw it without importing the renderer entry.

export class RenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RenderError";
  }
}
