/** What the Gander band draws: the bridge's answer to GET /api/mod/band. */
export type Band = {
  /** Sessions waiting on a person, across every project (the needs-you rail). */
  needsYou: number
  /** This session's spend in US dollars, as the engine reports it. */
  spendUsd: number | null
  /** This session's context fill, 0 to 100. */
  ctxPercent: number | null
  /** The dashboard's address, for the band's hint. */
  url: string
}

declare module 'claude-code' {
  interface PluginState {
    'gander-feed': {
      /** The last band the bridge answered; null until the first poll. */
      band: Band | null
      /** True once a POST to the bridge failed; the band hides, the poll keeps trying. */
      bridgeDown: boolean
      /** The person pressed Hide; stays for the session. */
      isHidden: boolean
    }
  }
}
