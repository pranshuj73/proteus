import type { RoutineDefinition, RoutineStep } from "@t3tools/contracts";

/** A single routine step placed on the static left-to-right graph. */
export interface RoutineGraphNode {
  readonly id: string;
  readonly title: string | null;
  readonly kind: RoutineStep["kind"];
  /** Short kind-specific summary: skill ref, agent purpose, command argv, or action name. */
  readonly detail: string;
  readonly column: number;
  readonly row: number;
}

/** A transition between two steps. `loop` edges point back to an earlier column. */
export interface RoutineGraphEdge {
  readonly from: string;
  readonly to: string;
  /** The verdict label for a gated (`on`) transition; `null` for an unconditional `next`. */
  readonly label: string | null;
  readonly loop: boolean;
}

export interface RoutineGraphLayout {
  readonly nodes: readonly RoutineGraphNode[];
  readonly edges: readonly RoutineGraphEdge[];
  readonly columnCount: number;
  readonly rowCount: number;
}

const END_TARGET = "$end";

interface RawEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string | null;
}

function stepDetail(step: RoutineStep): string {
  switch (step.kind) {
    case "skill":
      return step.skill;
    case "agent":
      return step.purpose;
    case "command":
      return step.argv.join(" ");
    case "action":
      return step.action;
  }
}

function collectEdges(step: RoutineStep, ids: ReadonlySet<string>): RawEdge[] {
  if (step.next !== undefined) {
    return step.next.filter((to) => ids.has(to)).map((to) => ({ from: step.id, to, label: null }));
  }
  if (step.on !== undefined) {
    const edges: RawEdge[] = [];
    for (const [label, to] of Object.entries(step.on)) {
      // `$end` is a sink, not a step, so it never becomes a node or an edge.
      if (to === END_TARGET || !ids.has(to)) continue;
      edges.push({ from: step.id, to, label });
    }
    return edges;
  }
  return [];
}

/**
 * Lays routine steps into left-to-right columns by longest path from the start, with back-edges
 * (targets at or before their source in declaration order) excluded from the longest-path pass so
 * cycles terminate. A rendered edge is a `loop` when its target lands in a column at or before its
 * source; those are drawn as dashed arcs above the nodes. Transitions to `$end` are dropped.
 */
export function layoutRoutineGraph(definition: RoutineDefinition): RoutineGraphLayout {
  const steps = definition.steps;
  const ids = new Set(steps.map((step) => step.id));
  const indexById = new Map<string, number>(steps.map((step, index) => [step.id, index] as const));

  const rawEdges = steps.flatMap((step) => collectEdges(step, ids));
  const forwardEdges = rawEdges.filter(
    (edge) => (indexById.get(edge.to) ?? 0) > (indexById.get(edge.from) ?? 0),
  );

  const column = new Map<string, number>(steps.map((step) => [step.id, 0] as const));
  // The forward subgraph is acyclic, so the longest path to any node has at most
  // steps.length - 1 edges; one relaxation pass per step settles every column.
  for (let pass = 0; pass < steps.length; pass += 1) {
    let changed = false;
    for (const edge of forwardEdges) {
      const candidate = (column.get(edge.from) ?? 0) + 1;
      if (candidate > (column.get(edge.to) ?? 0)) {
        column.set(edge.to, candidate);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const byColumn = new Map<number, string[]>();
  for (const step of steps) {
    const col = column.get(step.id) ?? 0;
    const bucket = byColumn.get(col);
    if (bucket === undefined) byColumn.set(col, [step.id]);
    else bucket.push(step.id);
  }
  const rowById = new Map<string, number>();
  for (const bucket of byColumn.values()) {
    bucket.forEach((id, row) => rowById.set(id, row));
  }

  const nodes = steps.map((step) => ({
    id: step.id,
    title: step.title ?? null,
    kind: step.kind,
    detail: stepDetail(step),
    column: column.get(step.id) ?? 0,
    row: rowById.get(step.id) ?? 0,
  }));

  const edges = rawEdges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    label: edge.label,
    loop: (column.get(edge.to) ?? 0) <= (column.get(edge.from) ?? 0),
  }));

  const columnCount = steps.length === 0 ? 0 : Math.max(...nodes.map((node) => node.column)) + 1;
  const rowCount =
    byColumn.size === 0 ? 0 : Math.max(...[...byColumn.values()].map((bucket) => bucket.length));

  return { nodes, edges, columnCount, rowCount };
}
