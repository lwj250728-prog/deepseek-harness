/**
 * cognition domain zod schemas (names derived from map keys:
 * cognitionListRequestSchema / cognitionListValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { ExplorationTaskCounts, ExplorationTaskStatus, ExplorationTaskView } from './cognition.ts'

/** ExplorationTaskStatus of cognition.list. */
export const explorationTaskStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']) satisfies z.ZodType<Wire<ExplorationTaskStatus>>

/** ExplorationTaskView row of cognition.list. */
export const explorationTaskViewSchema = z.object({
  taskId: z.string().min(1),
  goal: z.string(),
  status: explorationTaskStatusSchema,
  createdAt: z.number(),
  pickedUpAt: z.number().nullable(),
  result: z.string().nullable(),
}) satisfies z.ZodType<Wire<ExplorationTaskView>>

/** ExplorationTaskCounts of cognition.list. */
export const explorationTaskCountsSchema = z.object({
  pending: z.number(),
  running: z.number(),
  completed: z.number(),
  failed: z.number(),
}) satisfies z.ZodType<Wire<ExplorationTaskCounts>>

/** cognition.list request payload (no fields). */
export const cognitionListRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'cognition.list'>>>

/** cognition.list response value. */
export const cognitionListValueSchema = z.object({
  tasks: z.array(explorationTaskViewSchema),
  counts: explorationTaskCountsSchema,
}) satisfies z.ZodType<Wire<ResponseValue<'cognition.list'>>>
