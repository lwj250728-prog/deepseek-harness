/** Shared age label: how long ago a timestamp is (minutes/hours). */
export function ageLabel(createdAt: number, now: number = Date.now()): string {
  const ms = Math.max(0, now - createdAt)
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
