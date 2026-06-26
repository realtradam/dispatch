import type {
  AgentEvent,
  StepId,
  StepMetrics,
  TurnDoneEvent,
  TurnMetrics,
  TurnStepCompleteEvent,
  TurnUsageEvent,
  Usage,
} from "@dispatch/kernel";

const zeroUsage: Usage = { inputTokens: 0, outputTokens: 0 };

interface StepAccumulator {
  readonly stepId: StepId;
  usage: Usage | undefined;
  ttftMs: number | undefined;
  decodeMs: number | undefined;
  genTotalMs: number | undefined;
}

export interface MetricsAccumulator {
  readonly ingest: (event: AgentEvent) => void;
  readonly build: (turnId: string) => TurnMetrics;
  readonly reset: () => void;
}

export function createMetricsAccumulator(): MetricsAccumulator {
  const steps = new Map<StepId, StepAccumulator>();
  const stepOrder: StepId[] = [];
  let doneUsage: Usage | undefined;
  let doneDurationMs: number | undefined;

  function getOrCreateStep(stepId: StepId): StepAccumulator {
    let acc = steps.get(stepId);
    if (acc === undefined) {
      acc = {
        stepId,
        usage: undefined,
        ttftMs: undefined,
        decodeMs: undefined,
        genTotalMs: undefined,
      };
      steps.set(stepId, acc);
      stepOrder.push(stepId);
    }
    return acc;
  }

  function ingest(event: AgentEvent): void {
    switch (event.type) {
      case "usage": {
        const e = event as TurnUsageEvent;
        if (e.stepId !== undefined) {
          const acc = getOrCreateStep(e.stepId);
          acc.usage = e.usage;
        }
        break;
      }
      case "step-complete": {
        const e = event as TurnStepCompleteEvent;
        const acc = getOrCreateStep(e.stepId);
        acc.ttftMs = e.ttftMs;
        acc.decodeMs = e.decodeMs;
        acc.genTotalMs = e.genTotalMs;
        break;
      }
      case "done": {
        const e = event as TurnDoneEvent;
        doneUsage = e.usage;
        doneDurationMs = e.durationMs;
        break;
      }
    }
  }

  function build(turnId: string): TurnMetrics {
    const stepMetrics: StepMetrics[] = stepOrder.map((stepId) => {
      const acc = steps.get(stepId);
      if (acc === undefined) {
        return { stepId, usage: zeroUsage };
      }
      const usage = acc.usage ?? zeroUsage;
      const sm: StepMetrics = { stepId, usage };
      if (acc.ttftMs !== undefined) {
        (sm as { ttftMs?: number }).ttftMs = acc.ttftMs;
      }
      if (acc.decodeMs !== undefined) {
        (sm as { decodeMs?: number }).decodeMs = acc.decodeMs;
      }
      if (acc.genTotalMs !== undefined) {
        (sm as { genTotalMs?: number }).genTotalMs = acc.genTotalMs;
      }
      return sm;
    });

    const aggregateUsage = doneUsage ?? sumStepUsage(stepMetrics);

    const tm: TurnMetrics = { turnId, usage: aggregateUsage, steps: stepMetrics };
    if (doneDurationMs !== undefined) {
      (tm as { durationMs?: number }).durationMs = doneDurationMs;
    }

    // contextSize = final step's inputTokens + outputTokens (true context occupancy).
    // Omit when no steps or the last step had no usable per-step usage event.
    if (stepMetrics.length > 0) {
      const lastStep = stepMetrics[stepMetrics.length - 1];
      if (lastStep !== undefined) {
        const lastAcc = steps.get(lastStep.stepId);
        if (lastAcc?.usage !== undefined) {
          (tm as { contextSize?: number }).contextSize =
            lastStep.usage.inputTokens + lastStep.usage.outputTokens;
        }
      }
    }

    return tm;
  }

  function reset(): void {
    steps.clear();
    stepOrder.length = 0;
    doneUsage = undefined;
    doneDurationMs = undefined;
  }

  return { ingest, build, reset };
}

function sumStepUsage(steps: readonly StepMetrics[]): Usage {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const s of steps) {
    inputTokens += s.usage.inputTokens;
    outputTokens += s.usage.outputTokens;
  }
  return { inputTokens, outputTokens };
}
