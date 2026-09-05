/**
 * life domain zod schemas (names derived from map keys:
 * lifeOverviewRequestSchema / lifeOverviewValueSchema).
 */

import { z } from 'zod'
import type { RequestPayload, ResponseValue } from './rpc-map.ts'
import type { Wire } from './rpc.schema.ts'
import type { LifeChainHead, LifeTraceEntry } from './life.ts'

/** LifeChainHead of life.overview. */
export const lifeChainHeadSchema = z.object({
  nodeId: z.string().min(1),
  seq: z.number(),
  situation: z.string(),
  sessionId: z.string(),
  createdAt: z.number(),
}) satisfies z.ZodType<Wire<LifeChainHead>>

/** LifeTraceEntry of life.overview. */
export const lifeTraceEntrySchema = z.object({
  traceId: z.string().min(1),
  kind: z.enum(['inject', 'commit']),
  nodeId: z.string(),
  sessionId: z.string(),
  situation: z.string(),
  createdAt: z.number(),
  position: z.string().optional(),
  origin: z.string().optional(),
}) satisfies z.ZodType<Wire<LifeTraceEntry>>

/** life.overview request payload (no fields). */
export const lifeOverviewRequestSchema = z.object({}) satisfies z.ZodType<Wire<RequestPayload<'life.overview'>>>

/** life.overview response value. */
export const lifeOverviewValueSchema = z.object({
  chainHead: lifeChainHeadSchema.nullable(),
  traceTail: z.array(lifeTraceEntrySchema),
  designatedSessionId: z.string().nullable(),
}) satisfies z.ZodType<Wire<ResponseValue<'life.overview'>>>
