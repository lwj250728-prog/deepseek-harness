/**
 * Fiscal-map plugin, browser half: one Settings section rendering the
 * national fiscal choropleth. All data is embedded — the section needs no
 * services beyond the locale seat, so the registration carries no inject
 * face. Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the settings slot declarations (the 'settings.section'
// entry the section occupies) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { FiscalMapSection } from './FiscalMapSection.tsx'
import { en, zh, type FiscalMapLocaleKey } from './locales.ts'

export type { FiscalMapSectionProps } from './FiscalMapSection.tsx'
export type { FiscalMapLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The fiscal-map Settings section copy. */
    fiscalMap: FiscalMapLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'fiscalMap'

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * ui-settings-general's apply, whose activation order relative to this one is
 * NOT constrained; the registration depends on the declaration through
 * `slots.inject()` instead of assuming order.
 */
export const inject = ['slots', 'locale']

/**
 * Register the fiscal-map section once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-fiscal-map: dictionaries')

  const t = ctx.locale.bind(NS)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'fiscal-map',
    order: 20,
    label: () => t('nav'),
    locale: NS,
  }, FiscalMapSection))
}
