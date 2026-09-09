import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as constants from "./constants.js";
import { toPosixPath } from "./constants.js";

describe("toPosixPath", () => {
  it("converts Windows backslash separators to POSIX slashes", () => {
    assert.equal(toPosixPath("models\\user-class.puml"), "models/user-class.puml");
    assert.equal(toPosixPath("a\\b\\c.mmd"), "a/b/c.mmd");
  });

  it("leaves POSIX paths unchanged", () => {
    assert.equal(toPosixPath("models/user-class.puml"), "models/user-class.puml");
    assert.equal(toPosixPath("single.puml"), "single.puml");
    assert.equal(toPosixPath(""), "");
  });
});

describe("CHARACTER_LIMIT removal", () => {
  it("does not export a dead CHARACTER_LIMIT constant", () => {
    assert.equal(
      "CHARACTER_LIMIT" in constants,
      false,
      "CHARACTER_LIMIT should be removed; tool responses return full content with intact structured data",
    );
  });
});
