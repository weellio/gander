import { describe, expect, mock, test } from 'claude-code/testing'

type Posted = { kind: string; session_id: string; [k: string]: unknown }

const BAND = JSON.stringify({ needsYou: 2, spendUsd: 1.25, ctxPercent: 40, url: 'http://127.0.0.1:3131' })

/** Stand in for the engine beneath the plugin: a session, and a bridge that answers. */
function engine(on: Parameters<Parameters<typeof test>[1]>[1], opts: { bridgeOk?: boolean; throws?: boolean } = {}) {
  const posts: Posted[] = []
  const gets: string[] = []
  mock.clock(on)
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.version', () => ({ value: { version: '2.1.294', base: '2.1.294' } }))
  on('session.model', () => ({ value: 'claude-fable-5-1' }))
  on('command.register', ($, e) => ({ value: { name: e.name } }))
  // the chain events the tests raise: the engine's own answers
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('http.fetch', ($, e) => {
    if (opts.throws) throw new Error('ECONNREFUSED')
    if (e.init?.method === 'POST') posts.push(JSON.parse(String(e.init.body)))
    else gets.push(e.url)
    const ok = opts.bridgeOk !== false
    return { value: { status: ok ? 200 : 503, ok, headers: {}, text: ok ? BAND : 'down' } }
  })
  return { posts, gets }
}

describe('gander-feed', () => {
  test('session.start says hello and starts polling the band', async ($, on) => {
    const { posts, gets } = engine(on)
    await $.session.start({ cwd: 'D:/proj', surface: 'terminal', isInteractive: true })

    const hello = posts.find(p => p.kind === 'hello')
    expect(hello).toBeDefined()
    expect(hello!.session_id).toBe('sess-1')
    expect(hello!.version).toBe('2.1.294')
    expect(hello!.cwd).toBe('D:/proj')
    expect(gets.some(u => u.includes('/api/mod/band?session_id=sess-1'))).toBe(true)
  })

  test('session.measure forwards context, rate limits and cost, and passes the event on', async ($, on) => {
    const { posts } = engine(on)
    await $.session.start({ cwd: 'D:/proj', surface: 'terminal', isInteractive: true })
    const result = await $.session.measure({
      context: { tokens: 80_000, window: 200_000, percent: 40 },
      rateLimits: [{ kind: 'five_hour', percentUsed: 23.5 }],
      cost: { usd: 1.25 },
      changed: ['context', 'cost'],
    })

    expect(result.changed).toEqual(['context', 'cost'])
    const m = posts.find(p => p.kind === 'measure')
    expect(m).toBeDefined()
    expect(m!.context).toEqual({ tokens: 80_000, window: 200_000, percent: 40 })
    expect(m!.rateLimits).toEqual([{ kind: 'five_hour', percentUsed: 23.5, resetsAt: null }])
    expect(m!.costUsd).toBe(1.25)
  })

  test('turn.complete forwards the usage the engine filled in', async ($, on) => {
    const { posts } = engine(on)
    on('turn.complete', () => ({
      text: 'done',
      usage: { model: 'claude-fable-5-1', input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
    }))
    await $.session.start({ cwd: 'D:/proj', surface: 'terminal', isInteractive: true })
    const r = await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done', durationMs: 1200, isAborted: false })

    expect(r.text).toBe('done')
    const t = posts.find(p => p.kind === 'turn')
    expect(t).toBeDefined()
    expect(t!.usage).toEqual({ model: 'claude-fable-5-1', input: 10, output: 20, cacheRead: 30, cacheWrite: 40 })
  })

  test('a bridge that is down costs nothing: events pass, nothing throws', async ($, on) => {
    engine(on, { throws: true })
    await $.session.start({ cwd: 'D:/proj', surface: 'terminal', isInteractive: true })
    const result = await $.session.measure({
      context: { window: 200_000 }, rateLimits: [], changed: ['context'],
    })
    expect(result.changed).toEqual(['context'])
  })

  test('a bridge answering 5xx is treated the same as one that is down', async ($, on) => {
    const { posts } = engine(on, { bridgeOk: false })
    await $.session.start({ cwd: 'D:/proj', surface: 'terminal', isInteractive: true })
    const result = await $.session.measure({ context: { window: 200_000 }, rateLimits: [], changed: ['context'] })
    expect(result.changed).toEqual(['context'])
    expect(posts.some(p => p.kind === 'measure')).toBe(true)   // still tried; the bridge decides
  })
})
