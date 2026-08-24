/**
 * Task-restatement detection shared by the accumulation gate (reject new
 * records) and the injection retrieval (skip existing records). A delegated
 * task instruction that was auto-accumulated as an experience — its situation
 * is the verbatim task text, its action merely re-states the delegation with
 * no real tool trace — ranks at the top of every later injection for the same
 * task, crowding out the experiences that actually hold the solution (the
 * exp_155/168/173 lesson). Deterministic so the gate cannot be talked into
 * storing one by an over-eager LLM.
 * @module @deepseek-ai/dsh-cognitive-pipeline/task-restatement
 */

/** The minimal SAR slice this detector reads (an Experience or a raw triplet). */
export interface TaskRestatementCandidate {
  readonly sar: {
    readonly situation: string
    readonly action: string
  }
}

/** Whether one candidate is a task-restatement record.
 * @param candidate - the experience or extracted SAR to judge.
 * @returns true when the action shows no tool-operation trace and the
 *   situation reads like a task instruction.
 */
export function isTaskRestatement(candidate: TaskRestatementCandidate): boolean {
  const action = candidate.sar.action
  const situation = candidate.sar.situation
  const hasToolTrace = /调用|pwsh|Start-Process|Stop-Process|glob|grep|read|write|edit|explore|consolidate|remember/i.test(action)
  if (hasToolTrace) return false
  const instructionLike = /(任务|需要|请完成|请执行|要求)/.test(situation)
  const restatesDelegation = /(子代理执行|启动子代理|执行.{0,8}任务|按该|按照该|根据任务)/.test(action)
  return instructionLike && restatesDelegation
}
