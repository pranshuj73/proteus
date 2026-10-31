import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState, type ComponentProps } from "react";

import type {
  EnvironmentId,
  RoutineCouncilConfidence,
  RoutineExecutionId,
  RoutineFeedBlock,
} from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

type BadgeVariant = ComponentProps<typeof Badge>["variant"];

const CONFIDENCE_VARIANT: Record<RoutineCouncilConfidence, BadgeVariant> = {
  high: "success",
  medium: "secondary",
  low: "warning",
};

interface FeedTarget {
  readonly environmentId: EnvironmentId;
  readonly executionId: RoutineExecutionId;
}

function CouncilRecords({
  environmentId,
  executionId,
  block,
}: FeedTarget & { readonly block: RoutineFeedBlock }) {
  const query = useEnvironmentQuery(
    serverEnvironment.routineCouncilRecords({
      environmentId,
      input: { executionId, stepId: block.stepId, attempt: block.attempt },
    }),
  );
  if (query.error !== null) {
    return <p className="text-2xs text-destructive-foreground">{query.error}</p>;
  }
  if (query.data === null) {
    return <p className="text-2xs text-muted-foreground">Loading records...</p>;
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {query.data.records.map((record) => (
        <li key={record.id} className="flex flex-col gap-1 rounded border bg-muted/40 p-2">
          <div className="flex items-center gap-1.5">
            <Badge variant={CONFIDENCE_VARIANT[record.confidence]} size="sm">
              {record.confidence}
            </Badge>
            {record.independent ? null : (
              <Badge variant="outline" size="sm">
                Not independent
              </Badge>
            )}
          </div>
          <p className="text-2xs text-foreground">Q: {record.question}</p>
          <p className="text-2xs text-foreground">A: {record.answer}</p>
          <p className="text-2xs text-muted-foreground">{record.rationale}</p>
        </li>
      ))}
    </ul>
  );
}

function CouncilFeedBlock({
  environmentId,
  executionId,
  block,
}: FeedTarget & { readonly block: RoutineFeedBlock }) {
  const [showRecords, setShowRecords] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const regenerate = useAtomCommand(serverEnvironment.regenerateRoutineSummary, {
    label: "routine regenerate summary",
  });

  const regenerateSummary = async () => {
    if (regenerating) return;
    setRegenerating(true);
    const result = await regenerate({
      environmentId,
      input: { executionId, stepId: block.stepId, attempt: block.attempt },
    });
    setRegenerating(false);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not regenerate summary",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };

  const finished = block.stepStatus === "done" || block.stepStatus === "failed";
  return (
    <li className="flex flex-col gap-1.5 rounded-md border bg-card p-2.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {block.stepId}
          {block.attempt > 1 ? ` #${block.attempt}` : ""}
        </span>
        {block.verdict === null ? null : (
          <Badge variant="outline" size="sm" className="shrink-0">
            {block.verdict.label}
          </Badge>
        )}
      </div>
      {block.verdict === null ? null : (
        <p className="text-2xs text-muted-foreground">{block.verdict.reason}</p>
      )}
      {block.summary === null ? null : (
        <p className="whitespace-pre-wrap text-2xs text-foreground">{block.summary}</p>
      )}
      {block.flagged.map((entry) => (
        <div key={entry.recordId} className="flex flex-col gap-0.5">
          <Badge variant={CONFIDENCE_VARIANT[entry.confidence]} size="sm" className="self-start">
            Low confidence
          </Badge>
          <p className="text-2xs text-foreground">{entry.question}</p>
          <p className="text-2xs text-muted-foreground">Answered: {entry.answer}</p>
        </div>
      ))}
      {block.recordCount === 0 ? null : (
        <div className="flex items-center gap-1.5">
          <Button size="compact" variant="outline" onClick={() => setShowRecords((open) => !open)}>
            {showRecords ? "Hide records" : `Exact records (${block.recordCount})`}
          </Button>
          {finished ? (
            <Button
              size="compact"
              variant="outline"
              disabled={regenerating}
              onClick={() => void regenerateSummary()}
            >
              Regenerate
            </Button>
          ) : null}
        </div>
      )}
      {showRecords ? (
        <CouncilRecords environmentId={environmentId} executionId={executionId} block={block} />
      ) : null}
    </li>
  );
}

/** Newest-first council feed; the server only sends blocks for steps that have started. */
export function RoutineCouncilFeed({
  environmentId,
  executionId,
  feed,
}: FeedTarget & { readonly feed: ReadonlyArray<RoutineFeedBlock> }) {
  return (
    <aside className="flex min-w-0 flex-col gap-2 lg:w-1/4 lg:shrink-0">
      <h3 className="text-xs font-medium text-foreground">Council</h3>
      {feed.length === 0 ? (
        <p className="text-2xs text-muted-foreground">Nothing to report yet.</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {feed.map((block) => (
            <CouncilFeedBlock
              key={`${block.stepId}:${block.attempt}`}
              environmentId={environmentId}
              executionId={executionId}
              block={block}
            />
          ))}
        </ul>
      )}
    </aside>
  );
}
