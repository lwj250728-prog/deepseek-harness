import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as HandoverInvariant from '../src/invariant.ts'

/**
 * The companion installs **no** runtime check (this package appends no event of
 * its own), so its whole observable contract is the *registration*: the
 * invariant layer must be able to reserve this package's name, and disposing the
 * fiber must give the name back.
 *
 * Added 2026-09-13 (tp-194): mutating `apply` so it never registers left the
 * whole test lane **green** — the file had no coverage at all, and T28 could only
 * see that as "no textual reference". Either requirement below goes red when the
 * registration is removed or renames the package.
 */
describe('session-handover invariant companion', () => {
  it('reserves this package name while mounted and releases it on dispose', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(InvariantRegistry)
      const fiber = await ctx.plugin(HandoverInvariant)

      // ① while mounted the name IS taken — a companion that never registers
      //    (or registers under another package) fails here.
      expect(() => {
        ctx.invariants.register('@deepseek-ai/dsh-session-handover', () => {})
      }).toThrow(/already registered/u)

      // ② disposing releases it, so a reload can mount the companion again.
      await fiber.dispose()
      await expect(ctx.plugin(HandoverInvariant).await()).resolves.toBeDefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
