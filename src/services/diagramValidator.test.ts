import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  detectDiagramType,
  DiagramValidationError,
  validateDiagramSource,
} from "./diagramValidator.js";

const VALID_PLANTUML = "@startuml\ntitle User Domain Model\nclass User {\n  +id: int\n}\n@enduml\n";
const VALID_PLANTUML_MINIMAL = "@startuml\nclass Widget\n@enduml\n";
const VALID_MERMAID_SEQUENCE =
  "sequenceDiagram\n    participant Customer\n    Customer->>OrderService: Create order\n";
const VALID_MERMAID_FLOWCHART = "graph TD\n    A-->B\n";
const VALID_MERMAID_CLASS = "classDiagram\n    class User\n";

describe("diagramValidator PlantUML basic checks", () => {
  it("accepts a valid PlantUML example", () => {
    assert.doesNotThrow(() => validateDiagramSource(VALID_PLANTUML, "plantuml"));
  });

  it("accepts minimal PlantUML with both boundaries", () => {
    assert.doesNotThrow(() => validateDiagramSource(VALID_PLANTUML_MINIMAL, "plantuml"));
  });

  it("rejects empty and whitespace-only PlantUML source", () => {
    assert.throws(() => validateDiagramSource("", "plantuml"), DiagramValidationError);
    assert.throws(() => validateDiagramSource("   \n\t  \n", "plantuml"), DiagramValidationError);
  });

  it("rejects PlantUML missing boundaries", () => {
    assert.throws(
      () => validateDiagramSource("class User {\n  +id: int\n}\n", "plantuml"),
      /@startuml/i,
    );
    assert.throws(() => validateDiagramSource("@startuml\nclass User\n", "plantuml"), /@enduml/i);
    assert.throws(() => validateDiagramSource("class User\n@enduml\n", "plantuml"), /@startuml/i);
  });

  it("rejects PlantUML with reversed boundaries", () => {
    assert.throws(
      () => validateDiagramSource("@enduml\nclass User\n@startuml\n", "plantuml"),
      DiagramValidationError,
    );
  });

  it("identifies PlantUML format in the error without claiming full validation", () => {
    try {
      validateDiagramSource("not a diagram", "plantuml");
      assert.fail("expected DiagramValidationError");
    } catch (err: unknown) {
      assert.ok(err instanceof DiagramValidationError);
      assert.match((err as Error).message, /PlantUML/);
      assert.ok(!/fully valid|semantically valid/i.test((err as Error).message));
    }
  });
});

describe("diagramValidator Mermaid basic checks", () => {
  it("accepts valid Mermaid examples", () => {
    assert.doesNotThrow(() => validateDiagramSource(VALID_MERMAID_SEQUENCE, "mermaid"));
    assert.doesNotThrow(() => validateDiagramSource(VALID_MERMAID_FLOWCHART, "mermaid"));
    assert.doesNotThrow(() => validateDiagramSource(VALID_MERMAID_CLASS, "mermaid"));
  });

  it("accepts Mermaid with leading comments and init directives", () => {
    const withHeader =
      "%% title: Order flow\n%%{init: {'theme': 'dark'}}%%\nsequenceDiagram\n    A->>B: hi\n";
    assert.doesNotThrow(() => validateDiagramSource(withHeader, "mermaid"));
  });

  it("rejects empty and whitespace-only Mermaid source", () => {
    assert.throws(() => validateDiagramSource("", "mermaid"), DiagramValidationError);
    assert.throws(() => validateDiagramSource("  \n  \n", "mermaid"), DiagramValidationError);
  });

  it("rejects clearly invalid Mermaid prose", () => {
    assert.throws(
      () => validateDiagramSource("hello world this is not a diagram", "mermaid"),
      DiagramValidationError,
    );
    assert.throws(
      () => validateDiagramSource("just some random text\nmore text", "mermaid"),
      DiagramValidationError,
    );
  });

  it("rejects PlantUML pasted as Mermaid", () => {
    assert.throws(() => validateDiagramSource(VALID_PLANTUML, "mermaid"), DiagramValidationError);
  });

  it("rejects comment-only Mermaid source", () => {
    assert.throws(
      () => validateDiagramSource("%% title: nothing else\n", "mermaid"),
      DiagramValidationError,
    );
  });

  it("identifies Mermaid format in the error without claiming full validation", () => {
    try {
      validateDiagramSource("hello world", "mermaid");
      assert.fail("expected DiagramValidationError");
    } catch (err: unknown) {
      assert.ok(err instanceof DiagramValidationError);
      assert.match((err as Error).message, /Mermaid/);
      assert.ok(!/fully valid|semantically valid/i.test((err as Error).message));
    }
  });

  it("does not leak source content in the error", () => {
    const secret = "hello world secret-marker-9f3c";
    try {
      validateDiagramSource(secret, "mermaid");
      assert.fail("expected DiagramValidationError");
    } catch (err: unknown) {
      assert.ok(err instanceof Error);
      assert.ok(!(err as Error).message.includes("secret-marker-9f3c"));
    }
  });
});

describe("diagramValidator dialect detection from source", () => {
  it("recognizes PlantUML by its boundaries", () => {
    assert.equal(detectDiagramType(VALID_PLANTUML), "plantuml");
    assert.equal(detectDiagramType(VALID_PLANTUML_MINIMAL), "plantuml");
  });

  it("recognizes every Mermaid starter it validates", () => {
    for (const source of [
      VALID_MERMAID_SEQUENCE,
      VALID_MERMAID_FLOWCHART,
      VALID_MERMAID_CLASS,
      "stateDiagram-v2\n    [*] --> Active\n",
      "erDiagram\n    USER ||--o{ ORDER : places\n",
    ]) {
      assert.equal(detectDiagramType(source), "mermaid");
    }
  });

  it("skips leading comments and frontmatter before detecting Mermaid", () => {
    const withComments = "%% generated by tool\nsequenceDiagram\nparticipant A\n";
    assert.equal(detectDiagramType(withComments), "mermaid");
  });

  it("returns null for prose, empty, and separator-only sources", () => {
    for (const source of ["hello world", "", "   \n\t\n", "---\nonly frontmatter\n---\n"]) {
      assert.equal(detectDiagramType(source), null);
    }
  });

  it("returns null when a Mermaid opener is present without a diagram keyword", () => {
    assert.equal(detectDiagramType("A --> B\nB --> C\n"), null);
  });

  it("prefers PlantUML when both markers are present", () => {
    // A Mermaid source has no @startuml; a PlantUML one always does.
    assert.equal(detectDiagramType("@startuml\nflowchart TD\n@enduml\n"), "plantuml");
  });

  it("never returns a type for a source its own validation would reject", () => {
    for (const [source, type] of [
      ["@startuml\nclass User\n", "plantuml"],
      ["class User\n@enduml\n", "plantuml"],
      ["@enduml\n@startuml\n", "plantuml"],
    ] as const) {
      assert.equal(detectDiagramType(source), null, `${type} source must not detect as valid`);
      assert.throws(() => validateDiagramSource(source, type), DiagramValidationError);
    }
  });
});
