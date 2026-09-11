/** `goalTree` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'goalTree'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'panel.label': '目标轨迹',
  'panel.toggle.aria': '展开目标轨迹树',
  'panel.refresh.aria': '重新生成并刷新轨迹树',
  'panel.close.aria': '收起目标轨迹树',
  'panel.count': '{count} 个目标',
  'panel.generated': '生成于 {time}',
  'panel.justNow': '刚刚',
  'panel.minutesAgo': '{count} 分钟前',
  'panel.hoursAgo': '{count} 小时前',
  'panel.daysAgo': '{count} 天前',
  'panel.empty': '轨迹数据为空: 尚无目标。',
  'panel.error': '加载目标轨迹失败',
  'lane.completed': '已完成',
  'lane.executing': '执行中',
  'lane.planned': '规划',
  'lane.blocked': '阻塞',
  'goal.counts': '完成 {completed} 执行 {executing} 规划 {planned}',
  'goal.wakes': '唤醒 {count}',
  'goal.adopted': '采纳 {count}',
  'goal.next': '下一步',
  'goal.steps': '{count} 步',
  'goal.expand.aria': '展开目标步骤',
  'goal.waiting': '等待中',
  'step.evidence': '证据',
  'step.noevidence': '（无证据文本）',
  'step.reviewBy': '复核 {date}',
  'status.active': 'active',
  'status.dormant': 'dormant',
  'status.paused': 'paused',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<GoalTreeKey, string> = {
  'panel.label': 'Goal trajectory',
  'panel.toggle.aria': 'Expand the goal trajectory tree',
  'panel.refresh.aria': 'Regenerate and refresh the trajectory tree',
  'panel.close.aria': 'Collapse the goal trajectory tree',
  'panel.count': '{count} goals',
  'panel.generated': 'generated {time}',
  'panel.justNow': 'just now',
  'panel.minutesAgo': '{count}m ago',
  'panel.hoursAgo': '{count}h ago',
  'panel.daysAgo': '{count}d ago',
  'panel.empty': 'No trajectory data yet: no goals.',
  'panel.error': 'Failed to load the goal trajectory',
  'lane.completed': 'completed',
  'lane.executing': 'executing',
  'lane.planned': 'planned',
  'lane.blocked': 'blocked',
  'goal.counts': '{completed} done · {executing} live · {planned} planned',
  'goal.wakes': '{count} wakes',
  'goal.adopted': '{count} adopted',
  'goal.next': 'Next',
  'goal.steps': '{count} steps',
  'goal.expand.aria': 'Expand the goal steps',
  'goal.waiting': 'waiting',
  'step.evidence': 'Evidence',
  'step.noevidence': '(no evidence text)',
  'step.reviewBy': 'review {date}',
  'status.active': 'active',
  'status.dormant': 'dormant',
  'status.paused': 'paused',
}

/** Key domain of the `goalTree` namespace (zh is the source of truth). */
export type GoalTreeKey = keyof typeof zh
