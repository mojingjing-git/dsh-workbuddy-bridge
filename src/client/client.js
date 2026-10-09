/**
 * Client half of dsh-workbuddy-bridge.
 *
 * Plan reference: V2.2.1 §6 (UI surfaces), M01 evidence (decoration
 * template), M10 evidence (DSH client module protocol).
 *
 * What this module renders
 * -------------------------
 * The exact Slot names to inject into are still being finalised at P1
 * (TODO M10.1 in the probe report). For V1 the client ships **two**
 * safe surfaces:
 *
 *   1. A status badge in the conversation composer dock. This is the
 *      same Slot the official decoration template uses
 *      (M01: `conversation.composer.dock`). It is harmless even if
 *      duplicated by other plugins: the slot is the conversation
 *      compose area and shows a small chip "WorkBuddy: cn" / "WorkBuddy:
 *      off" so the user always knows the bridge's state.
 *
 *   2. A "Sign in with WorkBuddy" entry in the conversation account
 *      list. The Slot name is a best-effort guess; if the runtime
 *      doesn't expose it, the entry simply doesn't render — the
 *      `ctx.slots.inject` callback just no-ops.
 *
 * Both surfaces are read-only: clicking either opens no popup and
 * triggers no shell command. The actual sign-in is driven by
 * `ctx.remote.workbuddy.startOAuth()` (the host's typert service).
 *
 * Why this is plain JavaScript
 * ----------------------------
 * The DSH client module loader speaks ESM-like `factory(require)` but
 * it lives inside a webview where TypeScript transpilation is not
 * available. Decoration template is the precedent (M01). We keep the
 * same shape.
 */
window.__ModuleLoader__.load({
  id: 'dsh-workbuddy-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // The host exposes a small typert surface: { state, signIn }. We
    // poke it via `window.__DSH_REMOTE__` once the host's typert is
    // mounted. If the host isn't up yet (early boot), the badge shows
    // 'WorkBuddy: starting…' until the first state message arrives.
    const remotes = (typeof window !== 'undefined' && window.__DSH_REMOTE__) || {}

    function getState() {
      const wb = remotes.workbuddy
      if (wb === undefined || typeof wb.getState !== 'function') {
        return { configured: false, status: 'starting' }
      }
      try {
        return wb.getState()
      } catch (_e) {
        return { configured: false, status: 'error' }
      }
    }

    function StatusBadge() {
      const state = getState()
      const label = state.configured
        ? `WorkBuddy: ${state.realm ?? 'cn'}`
        : 'WorkBuddy: off'
      return h(
        'span',
        {
          title: 'dsh-workbuddy-bridge',
          'aria-label': label,
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            fontSize: '11px',
            padding: '2px 8px',
            borderRadius: '10px',
            background: state.configured ? 'rgba(36,123,191,0.12)' : 'rgba(127,127,127,0.12)',
            color: state.configured ? '#247bbf' : 'rgba(127,127,127,0.9)',
            pointerEvents: 'none',
          },
        },
        label,
      )
    }

    function SignInButton() {
      const onClick = () => {
        const wb = remotes.workbuddy
        if (wb !== undefined && typeof wb.startOAuth === 'function') {
          void wb.startOAuth()
        }
      }
      return h(
        'button',
        {
          type: 'button',
          onClick,
          style: {
            fontSize: '12px',
            padding: '4px 10px',
            borderRadius: '6px',
            border: '1px solid #247bbf',
            background: 'transparent',
            color: '#247bbf',
            cursor: 'pointer',
          },
        },
        'Sign in with WorkBuddy',
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 1. Conversation composer dock badge (M01 Slot: safe default).
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            { name: 'conversation.composer.dock', id: 'workbuddy-status', order: 50 },
            StatusBadge,
          ),
        )

        // 2. Best-effort: conversation account list (rendered only if the
        //    DSH client exposes this Slot). Unknown Slot names are
        //    silently ignored by the slot registry.
        for (const slotName of [
          'conversation.account.list',
          'sidebar.workbuddy.entry',
          'header.workbuddy.entry',
        ]) {
          ctx.slots.inject(slotName, () =>
            ctx.slots.register(
              { name: slotName, id: 'workbuddy-signin', order: 30 },
              SignInButton,
            ),
          )
        }
      },
    }
  },
})
