// Kroog's mod. It does one thing: after each turn, and whenever a rate-limit window moves,
// it sends this chat's plan usage (the 5-hour and weekly windows) and cost to the Kroog
// running on this computer, at 127.0.0.1. It reads one file (Kroog's token, so Kroog knows the
// reading is real), talks to no other host, and never sees credentials.
import type { Register } from 'claude-code'

let port = 4877
let token: string | null = null

async function tokenOf($: Parameters<Parameters<Register>[0]>[2] extends (...args: infer A) => unknown ? A[0] : never): Promise<string> {
  if (token !== null) return token
  try {
    // Kroog's folder: KROOG_HOME when set (as Kroog itself reads it), else ~/.kroog.
    const dir = (await $.env.get('KROOG_HOME')) || `${await $.env.get('HOME')}/.kroog`
    const read = await $.fs.read(`${dir}/token`)
    token = (typeof read === 'string' ? read : '').trim()
  } catch {
    token = ''
  }
  return token
}

async function send($: Parameters<Parameters<Register>[0]>[2] extends (...args: infer A) => unknown ? A[0] : never, usage: { rateLimits?: unknown; cost?: unknown; context?: unknown }): Promise<void> {
  const t = await tokenOf($)
  if (!t) return
  const body = JSON.stringify({
    sessionId: await $.session.id(),
    cwd: await $.session.cwd(),
    rateLimits: usage.rateLimits ?? [],
    cost: usage.cost ?? null,
    context: usage.context ?? null,
  })
  try {
    await $.http.fetch(`http://127.0.0.1:${port}/hook/measure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Kroog-Token': t },
      body,
    })
  } catch {
    // Kroog is not running. Nothing to do; the next reading tries again.
  }
}

export const register: Register = (on, options) => {
  port = Number(options.port) || 4877

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    try { await send($, await $.session.usage()) } catch { /* no reading yet */ }
    return r
  })

  on('session.measure', ($, e, next) => {
    void send($, e)
    return next(e)
  })
}
