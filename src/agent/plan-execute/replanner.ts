/**
 * Replanning hooks for plan-execute.
 */

import type { AppState } from "../context.js";
import type { Plan, Task, PlanExecutionStep } from "./types.js";

export interface ReplanRequest {
  goal: string;
  plan: Plan;
  failedTask: Task;
  failedStep: PlanExecutionStep;
  remainingTasks: Task[];
  context: AppState;
  steps: PlanExecutionStep[];
}

export interface ReplanResult {
  plan: Plan;
  reason?: string;
}

export interface Replanner {
  replan(request: ReplanRequest): Promise<ReplanResult | null>;
}
