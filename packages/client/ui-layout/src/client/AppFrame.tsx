/**
 * Three-column shell frame, registered into the built-in 'root' slot (the web
 * shell renders only 'root'). Owns the grid tracks (sidebar | center |
 * details), the drag handles (pointer capture + rAF throttle), the concession
 * chain (columns.ts), and the child-slot render decisions: the sidebar slot
 * renders HERE with live parameters from the concession solve, and the
 * session-aware occupants render in fixed column positions; strict entries
 * gate themselves on current-session availability while session-maybe
 * entries retain identity. Pure component: everything arrives
 * through the three framework shares — zero cordis or framework imports,
 * zero self-made hooks.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  computeColumns, PHONE_BREAKPOINT, PHONE_SIDEBAR_MAX,
  SIDEBAR_AUTO_COLLAPSE, SIDEBAR_DEFAULT,
} from './columns.ts'
import type { createLayoutStore } from './stores.ts'
import css from './AppFrame.module.css'

/** Drawer slide duration; matches --ds-transition-duration-slow (0.3s). */
const DRAWER_SETTLE_MS = 300

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'details' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createLayoutStore>>

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
function DetailsColumn(props: { children?: ReactNode }) {
  return <div className={css.detailsCol}>{props.children}</div>
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: { side: 'sidebar' | 'details'; left: number; onStart: () => void; onDrag: (dx: number) => void; onEnd: () => void }) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

/** The three-column frame (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
}: AppFrameProps) {
  const panels = useStore(s => s)
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [viewport, setViewport] = useState(() => window.innerWidth)

  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      actions.closeDetails()
    }
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const width = el.getBoundingClientRect().width
        if (width > 0) setViewport(width)
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // Narrow viewports auto-collapse the sidebar; the store mirror keeps
  // toggleSidebar's semantics right (narrow toggles flip the manual
  // re-expand override, stores.ts). Collapsed is decided here, so the
  // solver stays breakpoint-free: a narrow re-expand passes the preference
  // (or the default when the wide preference is closed) and the center
  // absorbs the squeeze.
  const narrow = viewport < SIDEBAR_AUTO_COLLAPSE
  const phone = viewport < PHONE_BREAKPOINT
  useEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])
  const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0
  // Below the phone breakpoint the side panels stop sharing the center
  // column: the grid always solves with both closed (rail + full center) and
  // the expanded sidebar / opened details render as overlay drawers on top.
  // Between PHONE_BREAKPOINT and SIDEBAR_AUTO_COLLAPSE the squeeze stays.
  const sidebarDrawer = phone && !sidebarCollapsed
  const detailsDrawer = narrow && detailsSession !== undefined && panels.details > 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar
  const cols = computeColumns(
    viewport,
    sidebarDrawer ? 0 : sidebarPreference,
    detailsDrawer ? 0 : detailsSession === undefined ? 0 : panels.details,
  )
  const colsRef = useRef(cols)
  colsRef.current = cols

  // Drawer phases: CSS cannot transition an element between in-flow and
  // absolutely positioned, so each drawer opens in two steps — mount off-
  // screen (absolute), then slide in on the next frame; closing plays the
  // slide-out before the sidebar returns to its in-flow rail (details snaps
  // back to its zero track, which is already invisible).
  const [sidebarPhase, setSidebarPhase] = useState<'in-flow' | 'off' | 'open'>('in-flow')
  useEffect(() => {
    if (!phone) { setSidebarPhase('in-flow'); return }
    if (sidebarDrawer) {
      if (sidebarPhase === 'in-flow') { setSidebarPhase('off'); return }
      if (sidebarPhase === 'off') {
        const raf = requestAnimationFrame(() => { setSidebarPhase('open') })
        return () => { cancelAnimationFrame(raf) }
      }
      return
    }
    if (sidebarPhase === 'open') { setSidebarPhase('off'); return }
    if (sidebarPhase === 'off') {
      const timer = window.setTimeout(() => { setSidebarPhase('in-flow') }, DRAWER_SETTLE_MS)
      return () => { window.clearTimeout(timer) }
    }
  }, [phone, sidebarDrawer, sidebarPhase])

  const [detailsPhase, setDetailsPhase] = useState<'in-flow' | 'off' | 'open'>('in-flow')
  useEffect(() => {
    if (!detailsDrawer) { setDetailsPhase('in-flow'); return }
    if (detailsPhase === 'in-flow') { setDetailsPhase('off'); return }
    if (detailsPhase === 'off') {
      const raf = requestAnimationFrame(() => { setDetailsPhase('open') })
      return () => { cancelAnimationFrame(raf) }
    }
  }, [detailsDrawer, detailsPhase])

  // On phones the drawer is the whole navigation surface: picking a session
  // from it (the current-session id changes while it is open) closes it so
  // the conversation is immediately usable. The baseline is captured on
  // open/close so a phase change alone never trips the comparison.
  const lastDrawerSession = useRef(detailsSession)
  useEffect(() => {
    if (!phone || sidebarPhase === 'in-flow') {
      lastDrawerSession.current = detailsSession
      return
    }
    if (lastDrawerSession.current !== detailsSession) {
      lastDrawerSession.current = detailsSession
      actions.toggleSidebar()
    }
  }, [phone, sidebarPhase, detailsSession, actions])

  const phoneSidebarWidth = Math.min(Math.round(viewport * 0.84), PHONE_SIDEBAR_MAX)

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const detailsBase = useRef(0)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onDetailsStart = useCallback(() => { detailsBase.current = colsRef.current.details; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onDetailsDrag = useCallback((dx: number) => {
    actions.setDetails(detailsBase.current - dx)
  }, [actions])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{ gridTemplateColumns: `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px` }}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={cols.details === 0 || undefined}
      data-dragging={dragging || undefined}
      data-phone-sidebar={phone && sidebarPhase !== 'in-flow' ? sidebarPhase : undefined}
      data-phone-details={detailsPhase !== 'in-flow' ? detailsPhase : undefined}
    >
      <div className={css.sidebarCol}>
        {/* Render-site slot call with live concession output: a closed
            sidebar keeps the mounted slot at the compact-rail width, and the
            component sees its rendered state as owner params decided here
            (collapsed follows the resolved rail, so a derived auto-collapse
            renders the rail UI too). Inside the phone drawer the slot renders
            its expanded content at the drawer width. */}
        {renderSlot('sidebar', {
          collapsed: sidebarCollapsed,
          width: sidebarDrawer ? phoneSidebarWidth : cols.sidebar,
        })}
      </div>
      <>
        {/* Both column occupants stay at fixed tree positions from first
            paint — no loading gate: a bare status line reads worse than
            the shell's own pending rendering. The conversation
            is session-maybe; the strict details entry naturally renders
            empty while no session is current. */}
        <CenterColumn>{renderSlot('conversation', {})}</CenterColumn>
        <DetailsColumn>{renderSlot('details', {})}</DetailsColumn>
      </>
      {/* Drawer scrims: tapping the dimmed center closes the drawer on top
          (the sidebar when both happen to be open). */}
      {phone && sidebarPhase !== 'in-flow' && (
        <div className={css.scrim} data-for="sidebar" onClick={() => { actions.toggleSidebar() }} />
      )}
      {detailsPhase !== 'in-flow' && (
        <div className={css.scrim} data-for="details" onClick={() => { actions.closeDetails() }} />
      )}
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {/* The collapsed rail is fixed-width: no resize handle while closed;
          drawers on phones are fixed-width too. */}
      {!phone && !sidebarCollapsed && <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />}
      {!phone && cols.details > 0 && <DragHandle side="details" left={viewport - cols.details} onStart={onDetailsStart} onDrag={onDetailsDrag} onEnd={onDragEnd} />}
    </div>
  )
}
