// gander-feed: the in-process companion to Gander's classic hooks.
//
// Classic hooks never see per-request usage, cache state, context fill or the
// rate-limit windows, so the bridge reconstructs those from transcript files.
// This module sees them live and POSTs them to the bridge's /api/mod, where
// they replace the estimates for this session. It also draws a one-line band
// above the prompt (needs-you count, spend, context fill) and answers /gander.
//
// Every network call is best-effort: a bridge that is down costs nothing and
// blocks nothing; the band hides and the next poll tries again.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Band } from '../types'

const VERSION = '0.1.0'

const bandAtom = atom({ plugin: 'gander-feed', key: 'band' } as const, null as Band | null)
const bridgeDown = atom({ plugin: 'gander-feed', key: 'bridgeDown' } as const, false)
const isHidden = atom({ plugin: 'gander-feed', key: 'isHidden' } as const, false)

// Set by register(); read by the helpers below.
let bridgeUrl = 'http://127.0.0.1:3131'
let sessionId: string | null = null
let cwd = ''

async function sid($: EngineInterface): Promise<string | null> {
  if (!sessionId) {
    try { sessionId = await $.session.id() } catch { sessionId = null }
  }
  return sessionId
}

async function markBridge($: EngineInterface, down: boolean): Promise<void> {
  try {
    if ((await read($, bridgeDown)) !== down) await update($, bridgeDown, () => down)
  } catch { /* the environment is gone (a reload, the session's end): nothing to record */ }
}

async function post($: EngineInterface, kind: string, payload: Record<string, unknown>): Promise<void> {
  const session_id = await sid($)
  if (!session_id) return
  try {
    const res = await $.http.fetch(`${bridgeUrl}/api/mod`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, session_id, cwd, mod: VERSION, at: Date.now(), ...payload }),
    })
    await markBridge($, !res.ok)
  } catch {
    await markBridge($, true)
  }
}

async function poll($: EngineInterface): Promise<void> {
  const session_id = await sid($)
  if (!session_id) return
  try {
    const res = await $.http.fetch(`${bridgeUrl}/api/mod/band?session_id=${encodeURIComponent(session_id)}`)
    if (!res.ok) throw new Error(String(res.status))
    const band = JSON.parse(res.text) as Band
    try { await update($, bandAtom, () => band) } catch { return }
    await markBridge($, false)
  } catch {
    await markBridge($, true)
  }
}

export const register: Register = (on, options) => {
  bridgeUrl = String(options.bridgeUrl || 'http://127.0.0.1:3131').replace(/\/+$/, '')
  const wantBand = options.band !== false
  const pollMs = Math.max(5, Number(options.pollSeconds) || 15) * 1000

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    sessionId = null
    await sid($)
    let version = ''
    let model = ''
    try { version = (await $.session.version()).version } catch { /* an older engine */ }
    try { model = await $.session.model() } catch { /* not bound yet */ }
    void post($, 'hello', { version, model, surface: e.surface, isInteractive: e.isInteractive })

    try {
      await $.command.register({ name: 'gander', description: 'Show where the Gander dashboard is and whether the bridge is reachable.' })
    } catch { /* registered by an earlier load */ }

    void poll($)
    $.clock.every(pollMs, () => { void poll($) })

    return next(e)
  })

  on('command.run', { command: 'gander' }, async $ => {
    await poll($)
    const down = await read($, bridgeDown)
    const band = await read($, bandAtom)
    const url = band?.url || bridgeUrl
    if (down) return { text: `Gander bridge is not answering at ${bridgeUrl}. Start it with: node bridge/server.js --port 3131` }
    const parts = [`Gander: ${url}`]
    if (band) {
      parts.push(`${band.needsYou} session${band.needsYou === 1 ? '' : 's'} need you`)
      if (band.spendUsd != null) parts.push(`this session $${band.spendUsd.toFixed(2)}`)
      if (band.ctxPercent != null) parts.push(`context ${band.ctxPercent}%`)
    }
    return { text: parts.join(' · ') }
  })

  // The status line's figures, the moment they move.
  on('session.measure', async ($, e, next) => {
    void post($, 'measure', {
      context: { tokens: e.context.tokens ?? null, window: e.context.window, percent: e.context.percent ?? null },
      rateLimits: e.rateLimits.map(r => ({ kind: r.kind, percentUsed: r.percentUsed, resetsAt: r.resetsAt ?? null })),
      costUsd: e.cost?.usd ?? null,
      changed: e.changed,
    })
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    void post($, 'turn-start', { turnId: e.turnId, textLength: e.text.length })
    return next(e)
  })

  // One model request; inside a sub-agent's loop e.agentId names it. The
  // stream beneath is forwarded untouched.
  on('turn.step', async function* ($, e, next) {
    void post($, 'step', {
      turnId: e.turnId, index: e.index, model: e.model, effort: e.effort ?? null,
      messageCount: e.messageCount, agentId: e.agentId ?? null,
    })
    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const u = result.usage
    void post($, 'turn', {
      turnId: e.turnId, reason: e.reason,
      usage: u ? {
        model: u.model, input: u.input_tokens, output: u.output_tokens,
        cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens,
      } : null,
    })
    return result
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    void post($, 'spawn', {
      toolUseId: e.tool_use_id, subagentType: e.subagentType, description: e.description,
      model: result.model, agentId: result.agentId ?? null, teammateId: result.teammateId ?? null,
    })
    return result
  }).catch(($, e, next) => next(e))   // an observer: a failure here never stops a spawn

  on('session.end', async ($, e, next) => {
    await post($, 'bye', { reason: e.reason })
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!wantBand || e.props.hasSurvey) return next(e)
    const band = await read($, bandAtom)
    if (band === null || (await read($, bridgeDown)) || (await read($, isHidden))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const needs = band.needsYou > 0 ? `${band.needsYou} need you` : 'nobody waiting'
    const spend = band.spendUsd != null ? ` · $${band.spendUsd.toFixed(2)}` : ''
    const ctx = band.ctxPercent != null ? ` · ctx ${band.ctxPercent}%` : ''

    return (
      <Box>
        <Text dimColor>Gander: {needs}{spend}{ctx} · {band.url} </Text>
        <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
      </Box>
    )
  })
}
