import { describe, expect, it } from "vitest";
import type { OrgTreeNode } from "../../services/nodes";
import { activeSubtreeOnly } from "./OrgChartPage";

function node(id: string, parent_id: string | null, active: boolean): OrgTreeNode {
  return {
    id,
    parent_id,
    name: id,
    name_en: null,
    active,
    nature: null,
    nature_set_here: null,
    capabilities: [],
    seats: [],
  };
}

describe("activeSubtreeOnly", () => {
  it("keeps every node when the whole tree is active", () => {
    const nodes = [node("a", null, true), node("b", "a", true), node("c", "b", true)];
    expect(activeSubtreeOnly(nodes).map((n) => n.id)).toEqual(["a", "b", "c"]);
  });

  it("excludes an inactive node itself", () => {
    const nodes = [node("a", null, true), node("b", "a", false)];
    expect(activeSubtreeOnly(nodes).map((n) => n.id)).toEqual(["a"]);
  });

  it("transitively excludes every descendant of an inactive ancestor, regardless of the descendants' own active flag", () => {
    // A (active) -> B (inactive) -> C (active) -> D (active)
    const nodes = [
      node("a", null, true),
      node("b", "a", false),
      node("c", "b", true),
      node("d", "c", true),
    ];
    expect(activeSubtreeOnly(nodes).map((n) => n.id)).toEqual(["a"]);
  });

  it("is unaffected by array order -- a child listed before its inactive parent still resolves correctly", () => {
    const nodes = [
      node("c", "b", true),
      node("b", "a", false),
      node("d", "c", true),
      node("a", null, true),
    ];
    expect(new Set(activeSubtreeOnly(nodes).map((n) => n.id))).toEqual(new Set(["a"]));
  });

  it("does not crash on a cycle and does not include any node in it", () => {
    // x -> y -> x (should never happen -- org_guard_nodes refuses it server-side --
    // this only proves the client-side guard doesn't infinite-loop or throw).
    const nodes = [node("x", "y", true), node("y", "x", true)];
    expect(() => activeSubtreeOnly(nodes)).not.toThrow();
    expect(activeSubtreeOnly(nodes)).toEqual([]);
  });
});
