import type { RoutineDefinition, RoutineStep, RoutineStepRunStatus } from "@t3tools/contracts";

import { cn } from "../../lib/utils";

import { Badge } from "../ui/badge";
import {
  layoutRoutineGraph,
  type RoutineGraphEdge,
  type RoutineGraphNode,
} from "./routineGraphLayout";

const NODE_WIDTH = 184;
const NODE_HEIGHT = 72;
const COLUMN_GAP = 72;
const ROW_GAP = 28;
const PADDING = 20;
/** Head space reserved above the first row so dashed loop arcs never clip. */
const LOOP_MARGIN = 44;

const KIND_LABEL: Record<RoutineStep["kind"], string> = {
  skill: "Skill",
  agent: "Agent",
  command: "Command",
  action: "Action",
};

/** Static, non-animated node tints keyed by per-step run status. `pending` keeps the base card. */
const STATUS_NODE_CLASS: Record<RoutineStepRunStatus, string> = {
  pending: "",
  running: "border-info/60 bg-info/8 dark:bg-info/16",
  done: "border-success/60 bg-success/8 dark:bg-success/16",
  failed: "border-destructive/60 bg-destructive/8 dark:bg-destructive/16",
};

const nodeLeft = (column: number) => PADDING + column * (NODE_WIDTH + COLUMN_GAP);
const nodeTop = (row: number) => PADDING + LOOP_MARGIN + row * (NODE_HEIGHT + ROW_GAP);

function forwardPath(from: RoutineGraphNode, to: RoutineGraphNode): string {
  const startX = nodeLeft(from.column) + NODE_WIDTH;
  const startY = nodeTop(from.row) + NODE_HEIGHT / 2;
  const endX = nodeLeft(to.column);
  const endY = nodeTop(to.row) + NODE_HEIGHT / 2;
  const control = (endX - startX) / 2;
  return `M ${startX} ${startY} C ${startX + control} ${startY} ${endX - control} ${endY} ${endX} ${endY}`;
}

function loopPath(from: RoutineGraphNode, to: RoutineGraphNode): string {
  const startX = nodeLeft(from.column) + NODE_WIDTH / 2;
  const startY = nodeTop(from.row);
  const endX = nodeLeft(to.column) + NODE_WIDTH / 2;
  const endY = nodeTop(to.row);
  // Control points anchored above both ends draw a shallow arc that clears the nodes.
  const peakY = Math.min(startY, endY) - LOOP_MARGIN + 8;
  return `M ${startX} ${startY} C ${startX} ${peakY} ${endX} ${peakY} ${endX} ${endY}`;
}

function RoutineGraphEdgeLabel({
  edge,
  from,
  to,
}: {
  readonly edge: RoutineGraphEdge;
  readonly from: RoutineGraphNode;
  readonly to: RoutineGraphNode;
}) {
  if (edge.label === null) return null;
  const x = edge.loop
    ? (nodeLeft(from.column) + nodeLeft(to.column)) / 2 + NODE_WIDTH / 2
    : (nodeLeft(from.column) + NODE_WIDTH + nodeLeft(to.column)) / 2;
  const y = edge.loop
    ? Math.min(nodeTop(from.row), nodeTop(to.row)) - LOOP_MARGIN + 20
    : (nodeTop(from.row) + nodeTop(to.row)) / 2 + NODE_HEIGHT / 2 - 8;
  return (
    <text x={x} y={y} textAnchor="middle" className="fill-muted-foreground text-3xs font-medium">
      {edge.label}
    </text>
  );
}

export function RoutineGraph({
  definition,
  stepStatus,
}: {
  readonly definition: RoutineDefinition;
  readonly stepStatus?: ReadonlyMap<string, RoutineStepRunStatus>;
}) {
  const layout = layoutRoutineGraph(definition);
  const nodeById = new Map(layout.nodes.map((node) => [node.id, node] as const));

  const width =
    PADDING * 2 + layout.columnCount * NODE_WIDTH + (layout.columnCount - 1) * COLUMN_GAP;
  const height =
    PADDING +
    LOOP_MARGIN +
    layout.rowCount * NODE_HEIGHT +
    (layout.rowCount - 1) * ROW_GAP +
    PADDING;

  return (
    <div className="overflow-x-auto">
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${definition.name} step graph`}
      >
        <defs>
          <marker
            id="routine-graph-arrow"
            markerWidth="8"
            markerHeight="8"
            refX="7"
            refY="4"
            orient="auto"
          >
            <path d="M 0 0 L 8 4 L 0 8 z" className="fill-muted-foreground" />
          </marker>
        </defs>
        {layout.edges.map((edge) => {
          const from = nodeById.get(edge.from);
          const to = nodeById.get(edge.to);
          if (from === undefined || to === undefined) return null;
          return (
            <g key={`${edge.from}->${edge.to}:${edge.label ?? ""}`}>
              <path
                d={edge.loop ? loopPath(from, to) : forwardPath(from, to)}
                fill="none"
                strokeWidth={1.5}
                strokeDasharray={edge.loop ? "4 4" : undefined}
                markerEnd="url(#routine-graph-arrow)"
                className="stroke-muted-foreground"
              />
              <RoutineGraphEdgeLabel edge={edge} from={from} to={to} />
            </g>
          );
        })}
        {layout.nodes.map((node) => (
          <foreignObject
            key={node.id}
            x={nodeLeft(node.column)}
            y={nodeTop(node.row)}
            width={NODE_WIDTH}
            height={NODE_HEIGHT}
          >
            <div
              className={cn(
                "flex h-full flex-col gap-1 overflow-hidden rounded-md border bg-card p-2",
                stepStatus === undefined
                  ? null
                  : STATUS_NODE_CLASS[stepStatus.get(node.id) ?? "pending"],
              )}
            >
              <div className="flex items-center justify-between gap-1">
                <span className="truncate text-xs font-medium text-foreground">
                  {node.title ?? node.id}
                </span>
                <Badge variant="secondary" size="sm" className="shrink-0">
                  {KIND_LABEL[node.kind]}
                </Badge>
              </div>
              {node.title === null ? null : (
                <span className="truncate font-mono text-3xs text-muted-foreground">{node.id}</span>
              )}
              <span className="truncate text-2xs text-muted-foreground">{node.detail}</span>
            </div>
          </foreignObject>
        ))}
      </svg>
    </div>
  );
}
