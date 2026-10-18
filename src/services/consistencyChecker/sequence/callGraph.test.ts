import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractCallEdges, type CallEdge } from "./callGraph.js";

interface CallGraphCase {
  name: string;
  stripped: string;
  expected: CallEdge[];
}

const CASES: CallGraphCase[] = [
  {
    name: "declaration and calls share one line in source order",
    stripped: "function run() { login(); checkout(); }\n",
    expected: [
      { caller: "run", callee: "login", viaCallback: false, line: 1 },
      { caller: "run", callee: "checkout", viaCallback: false, line: 1 },
    ],
  },
  {
    name: "recursive same-name call on the declaration line is retained",
    stripped: "function login() { login(); }\n",
    expected: [{ caller: "login", callee: "login", viaCallback: false, line: 1 }],
  },
  {
    name: "recursive calls around another call retain source order",
    stripped: "function login() { login(); audit(); login(); }\n",
    expected: [
      { caller: "login", callee: "login", viaCallback: false, line: 1 },
      { caller: "login", callee: "audit", viaCallback: false, line: 1 },
      { caller: "login", callee: "login", viaCallback: false, line: 1 },
    ],
  },
  {
    name: "generator declaration token is skipped while its recursive call is retained",
    stripped: "function* login() { login(); }\n",
    expected: [{ caller: "login", callee: "login", viaCallback: false, line: 1 }],
  },
  {
    name: "one-line python recursive call is retained",
    stripped: "def login(): login()\n",
    expected: [{ caller: "login", callee: "login", viaCallback: false, line: 1 }],
  },
  {
    name: "assigned-arrow recursive call is retained when its parameter has a different name",
    stripped: "const login = (request) => login();\n",
    expected: [{ caller: "login", callee: "login", viaCallback: true, line: 1 }],
  },
  {
    name: "assigned-arrow call matching its parameter remains deferred",
    stripped: "const login = (login) => login();\n",
    expected: [{ caller: "login", callee: "login", viaCallback: true, line: 1 }],
  },
  {
    name: "bare assigned-arrow recursive call is retained as a deferred callback",
    stripped: "const login = () => login();\n",
    expected: [{ caller: "login", callee: "login", viaCallback: true, line: 1 }],
  },
  {
    name: "python declaration sets the caller for following lines",
    stripped: "def run():\n  login()\n  checkout()\n",
    expected: [
      { caller: "run", callee: "login", viaCallback: false, line: 2 },
      { caller: "run", callee: "checkout", viaCallback: false, line: 3 },
    ],
  },
  {
    name: "arrow declaration marks the same-line call as a callback",
    stripped: "const run = () => login();\n",
    expected: [{ caller: "run", callee: "login", viaCallback: true, line: 1 }],
  },
  {
    name: "callback wrapper keeps source order and flags both calls",
    stripped: "function run() {\n  setTimeout(() => login(), 10);\n}\n",
    expected: [
      { caller: "run", callee: "setTimeout", viaCallback: true, line: 2 },
      { caller: "run", callee: "login", viaCallback: true, line: 2 },
    ],
  },
  {
    name: "caller persists past closing braces",
    stripped: "function first() {\n  login();\n}\ncheckout();\n",
    expected: [
      { caller: "first", callee: "login", viaCallback: false, line: 2 },
      { caller: "first", callee: "checkout", viaCallback: false, line: 4 },
    ],
  },
];

describe("callGraph extractCallEdges", () => {
  for (const { name, stripped, expected } of CASES) {
    it(name, () => {
      assert.deepEqual(extractCallEdges(stripped), expected);
    });
  }

  it("a subsequent extraction starts with a module caller and keeps requests independent", () => {
    const stripped = "function run() { login(); }\n";
    const expected: CallEdge[] = [{ caller: "run", callee: "login", viaCallback: false, line: 1 }];
    assert.deepEqual(extractCallEdges(stripped), expected);
    assert.deepEqual(extractCallEdges("checkout();\n"), [
      { caller: "<module>", callee: "checkout", viaCallback: false, line: 1 },
    ]);
    assert.deepEqual(extractCallEdges(stripped), expected);
  });
});
