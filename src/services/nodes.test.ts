import { describe, expect, it } from "vitest";
import { isNodeEffectivelyActive, type OrgTreeNode } from "./nodes";

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

describe("isNodeEffectivelyActive", () => {
  it("is true when the node and every ancestor are active", () => {
    const nodes = [node("a", null, true), node("b", "a", true), node("c", "b", true)];
    expect(isNodeEffectivelyActive(nodes, "c")).toBe(true);
  });

  it("is false when the node's own active column is false", () => {
    const nodes = [node("a", null, true), node("b", "a", false)];
    expect(isNodeEffectivelyActive(nodes, "b")).toBe(false);
  });

  it("is false when an ancestor is inactive even though the node's own column is true -- active does not cascade", () => {
    // A (active) -> B (inactive) -> C (active)
    const nodes = [node("a", null, true), node("b", "a", false), node("c", "b", true)];
    expect(isNodeEffectivelyActive(nodes, "c")).toBe(false);
  });

  it("is unaffected by array order", () => {
    const nodes = [
      node("c", "b", true),
      node("b", "a", false),
      node("d", "c", true),
      node("a", null, true),
    ];
    expect(isNodeEffectivelyActive(nodes, "d")).toBe(false);
  });

  it("does not crash on a cycle", () => {
    // org_guard_nodes refuses this server-side; this only proves the depth cap
    // stops the walk rather than looping forever.
    const nodes = [node("x", "y", true), node("y", "x", true)];
    expect(() => isNodeEffectivelyActive(nodes, "x")).not.toThrow();
  });

  it("is false for a node id absent from the snapshot", () => {
    const nodes = [node("a", null, true)];
    expect(isNodeEffectivelyActive(nodes, "missing")).toBe(false);
  });
});
