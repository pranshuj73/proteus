import { describe, expect, it } from "vite-plus/test";

import { RoutineStepId } from "@t3tools/contracts";
import type { RoutineDefinition, RoutineStep } from "@t3tools/contracts";

import { layoutRoutineGraph, type RoutineGraphLayout } from "./routineGraphLayout";

const sid = (id: string) => RoutineStepId.make(id);

function agent(
  id: string,
  links: { next?: readonly string[]; on?: Record<string, string> } = {},
): RoutineStep {
  const base: Record<string, unknown> = {
    kind: "agent",
    id: sid(id),
    purpose: `do ${id}`,
    verdict: { labels: ["approved", "rejected"] },
  };
  if (links.next !== undefined) base.next = links.next.map(sid);
  if (links.on !== undefined) {
    base.on = Object.fromEntries(
      Object.entries(links.on).map(([label, target]) => [
        label,
        target === "$end" ? "$end" : sid(target),
      ]),
    );
  }
  return base as RoutineStep;
}

function routine(steps: readonly RoutineStep[], start?: string): RoutineDefinition {
  return {
    version: 1,
    name: "Test routine",
    steps,
    ...(start === undefined ? {} : { start: sid(start) }),
  } as RoutineDefinition;
}

const columnOf = (layout: RoutineGraphLayout, id: string) =>
  layout.nodes.find((node) => node.id === id)?.column;

const rowOf = (layout: RoutineGraphLayout, id: string) =>
  layout.nodes.find((node) => node.id === id)?.row;

describe("layoutRoutineGraph", () => {
  it("assigns one column per step in a linear chain", () => {
    const layout = layoutRoutineGraph(
      routine([agent("a", { next: ["b"] }), agent("b", { next: ["c"] }), agent("c")]),
    );

    expect(columnOf(layout, "a")).toBe(0);
    expect(columnOf(layout, "b")).toBe(1);
    expect(columnOf(layout, "c")).toBe(2);
    expect(layout.columnCount).toBe(3);
    expect(layout.rowCount).toBe(1);
    expect(layout.edges.every((edge) => !edge.loop)).toBe(true);
  });

  it("places a fan-out on one column and a join by its longest path", () => {
    const layout = layoutRoutineGraph(
      routine([
        agent("a", { next: ["b", "c"] }),
        agent("b", { next: ["d"] }),
        agent("c", { next: ["d"] }),
        agent("d"),
      ]),
    );

    expect(columnOf(layout, "a")).toBe(0);
    expect(columnOf(layout, "b")).toBe(1);
    expect(columnOf(layout, "c")).toBe(1);
    // The join waits for both branches, so it sits one column past the fan-out.
    expect(columnOf(layout, "d")).toBe(2);
    // The two fanned-out steps stack in distinct rows within their shared column.
    expect(rowOf(layout, "b")).toBe(0);
    expect(rowOf(layout, "c")).toBe(1);
    expect(rowOf(layout, "d")).toBe(0);
    expect(layout.rowCount).toBe(2);
  });

  it("flags a back-edge as a loop and keeps its verdict label", () => {
    const layout = layoutRoutineGraph(
      routine([
        agent("a", { next: ["b"] }),
        agent("b", { next: ["c"] }),
        agent("c", { on: { redo: "b", done: "$end" } }),
      ]),
    );

    const loopEdge = layout.edges.find((edge) => edge.from === "c" && edge.to === "b");
    expect(loopEdge).toBeDefined();
    expect(loopEdge?.loop).toBe(true);
    expect(loopEdge?.label).toBe("redo");

    const forwardEdges = layout.edges.filter((edge) => edge.to !== "b");
    expect(forwardEdges.every((edge) => !edge.loop)).toBe(true);
  });

  it("drops transitions to $end", () => {
    const layout = layoutRoutineGraph(
      routine([agent("a", { on: { go: "b", stop: "$end" } }), agent("b")]),
    );

    expect(layout.edges).toHaveLength(1);
    expect(layout.edges[0]).toMatchObject({ from: "a", to: "b", label: "go", loop: false });
    expect(layout.edges.some((edge) => edge.to === "$end")).toBe(false);
  });
});
