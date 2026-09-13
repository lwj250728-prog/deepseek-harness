import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { frameSummary } from '../src/summarizer.ts'

/**
 * The landed checkpoint must carry **exactly one** `<compacted-summary>` pair.
 *
 * 2026-09-13: the checkpoint landed as
 * `<compacted-summary><compacted-summary>…</compacted-summary></compacted-summary>`
 * — the wrapper was written twice, because the compaction instruction names the
 * tag (so the summarizer may echo it) and `frameSummary` wrapped unconditionally.
 * These cases pin the idempotence; the third one is the exact shape that shipped.
 */
const text = (blocks: readonly ContentBlock[]): string =>
  blocks.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('')

const count = (value: string, needle: string): number => value.split(needle).length - 1

describe('frameSummary wrapper is idempotent', () => {
  it('wraps a bare summary exactly once', () => {
    const out = frameSummary([{ type: 'text', text: '## Next Step\n- keep going' }])
    const s = text(out)
    expect(count(s, '<compacted-summary>')).toBe(1)
    expect(count(s, '</compacted-summary>')).toBe(1)
    expect(s).toContain('## Next Step\n- keep going')
  })

  it('does not double the wrapper when the summary already carries one', () => {
    const out = frameSummary([
      { type: 'text', text: '<compacted-summary>\n## Next Step\n- keep going\n</compacted-summary>' },
    ])
    const s = text(out)
    expect(count(s, '<compacted-summary>')).toBe(1)
    expect(count(s, '</compacted-summary>')).toBe(1)
    expect(s).toContain('## Next Step\n- keep going')
  })

  it('collapses the doubly wrapped shape that actually shipped', () => {
    const out = frameSummary([
      { type: 'text', text: '<compacted-summary>\n<compacted-summary>\n## Next Step\n- keep going\n</compacted-summary>\n</compacted-summary>' },
    ])
    const s = text(out)
    expect(count(s, '<compacted-summary>')).toBe(1)
    expect(count(s, '</compacted-summary>')).toBe(1)
    expect(s).toContain('## Next Step\n- keep going')
  })

  it('keeps multi-block summaries intact and strips tags on the outer blocks only', () => {
    const out = frameSummary([
      { type: 'text', text: '<compacted-summary>\nfirst half' },
      { type: 'text', text: 'middle mentions <compacted-summary> as a concept' },
      { type: 'text', text: 'second half\n</compacted-summary>' },
    ])
    const s = text(out)
    expect(count(s, '<compacted-summary>')).toBe(2)   // wrapper + the mid-block mention
    expect(count(s, '</compacted-summary>')).toBe(1)  // wrapper only
    expect(s).toContain('first half')
    expect(s).toContain('second half')
  })
})
