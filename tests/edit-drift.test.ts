/**
 * Drift detection for the storage path.
 *
 * The live-room path re-anchors blocks with CRDT relative positions; the storage
 * path has no anchors, so a block carries the text it was written against. If the
 * document moved since, applying by the recorded line numbers replaces whatever now
 * sits there — the reviewer approved one passage and a different one changes.
 *
 * These pin the check that lets the caller refuse instead of writing blind.
 */

import { describe, it, expect } from "vitest";
import { detectDrift, applyBlocksToContent } from "../src/edit-blocks";

const DOC = ["alpha", "bravo", "charlie", "delta"].join("\n");

describe("detectDrift", () => {
  it("reports nothing when the passage still matches", () => {
    expect(
      detectDrift(DOC, [
        { startLine: 2, endLine: 2, updated: "B", original: "bravo" },
      ])
    ).toEqual([]);
  });

  it("reports the range when the passage moved away", () => {
    // Line 2 now holds something else — a line was inserted or removed above it.
    const shifted = ["new first", "alpha", "bravo", "charlie", "delta"].join("\n");
    const drift = detectDrift(shifted, [
      { startLine: 2, endLine: 2, updated: "B", original: "bravo" },
    ]);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({
      startLine: 2,
      endLine: 2,
      expected: "bravo",
      found: "alpha",
    });
  });

  it("still applies cleanly when there is no drift", () => {
    const drift = detectDrift(DOC, [
      { startLine: 3, endLine: 3, updated: "C", original: "charlie" },
    ]);
    expect(drift).toEqual([]);
    const applied = applyBlocksToContent(DOC, [
      { startLine: 3, endLine: 3, updated: "C" },
    ]);
    expect(applied.content.split("\n")[2]).toBe("C");
  });

  it("reports every drifted block, not just the first", () => {
    const changed = ["alpha", "CHANGED", "charlie", "ALSO CHANGED"].join("\n");
    const drift = detectDrift(changed, [
      { startLine: 2, endLine: 2, updated: "x", original: "bravo" },
      { startLine: 4, endLine: 4, updated: "y", original: "delta" },
    ]);
    expect(drift).toHaveLength(2);
    expect(drift.map((d) => d.startLine)).toEqual([2, 4]);
  });

  it("compares multi-line ranges as a whole", () => {
    expect(
      detectDrift(DOC, [
        { startLine: 2, endLine: 3, updated: "BC", original: "bravo\ncharlie" },
      ])
    ).toEqual([]);
    const drift = detectDrift(DOC, [
      { startLine: 2, endLine: 3, updated: "BC", original: "bravo\ndelta" },
    ]);
    expect(drift).toHaveLength(1);
  });

  it("ignores blocks that never recorded an anchor", () => {
    // No `original` is a caller that did not capture one, not evidence of drift.
    expect(detectDrift(DOC, [{ startLine: 2, endLine: 2, updated: "B" }])).toEqual([]);
  });

  it("leaves out-of-range blocks to the apply step", () => {
    // Reported as an invalid range rather than as drift, so the two failure modes
    // do not get conflated in the response.
    expect(
      detectDrift(DOC, [{ startLine: 99, endLine: 99, updated: "x", original: "y" }])
    ).toEqual([]);
    expect(
      detectDrift(DOC, [{ startLine: 3, endLine: 1, updated: "x", original: "y" }])
    ).toEqual([]);
  });

  it("reports drift when the anchored passage is gone entirely", () => {
    // The document was emptied (or the passage deleted) since the proposal was
    // written. The text the reviewer approved no longer exists, so the edit cannot
    // be trusted to mean what it did — refuse rather than write over whatever is
    // there now.
    const drift = detectDrift("", [
      { startLine: 1, endLine: 1, updated: "x", original: "alpha" },
    ]);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ expected: "alpha", found: "" });
  });
});
