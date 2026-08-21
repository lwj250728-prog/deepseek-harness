/** `cognition` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'cognition'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'area.label': '学习会话',
  'area.label.expanded': '学习会话（{count}）',
  'count.running': '{count} 个学习中',
  'count.total': '{count} 个任务',
  'status.pending': '待执行',
  'status.running': '学习中',
  'status.completed': '已完成',
  'status.failed': '已失败',
  'filter.all': '全部',
  'filter.pending': '待执行',
  'filter.running': '学习中',
  'filter.completed': '已完成',
  'filter.failed': '已失败',
  'action.refresh': '刷新',
  'empty': '暂无学习任务',
  'empty.filtered': '没有符合筛选条件的任务',
  'goal.label': '目标',
  'result.label': '结果',
  'createdAt.label': '创建于',
  'list.aria': '学习任务列表',
  'refresh.aria': '刷新学习任务',
  'error.load': '加载学习任务失败',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<CognitionKey, string> = {
  'area.label': 'Learning',
  'area.label.expanded': 'Learning ({count})',
  'count.running': '{count} learning',
  'count.total': '{count} tasks',
  'status.pending': 'pending',
  'status.running': 'learning',
  'status.completed': 'completed',
  'status.failed': 'failed',
  'filter.all': 'All',
  'filter.pending': 'Pending',
  'filter.running': 'Learning',
  'filter.completed': 'Completed',
  'filter.failed': 'Failed',
  'action.refresh': 'Refresh',
  'empty': 'No learning tasks yet',
  'empty.filtered': 'No tasks match the filter',
  'goal.label': 'Goal',
  'result.label': 'Result',
  'createdAt.label': 'Created',
  'list.aria': 'Learning task list',
  'refresh.aria': 'Refresh learning tasks',
  'error.load': 'Failed to load learning tasks',
}

/** Key domain of the `cognition` namespace (zh is the source of truth). */
export type CognitionKey = keyof typeof zh
