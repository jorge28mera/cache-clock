import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit, TurnUsage } from 'claude-code'

import type { Chat, Handoff, KeepWarm, Limit } from '../types'

const chat = atom({ plugin: 'cache-clock', key: 'chat' } as const, null, { shape: 'chat-1' })
const keepWarm = atom({ plugin: 'cache-clock', key: 'keepWarm' } as const, { mode: 'off', until: 0, pings: 0 }, { shape: 'keep-warm-1' })
const handoff = atom({ plugin: 'cache-clock', key: 'handoff' } as const, 'idle')
const now = atom({ plugin: 'cache-clock', key: 'now' } as const, 0)
const limits = atom({ plugin: 'cache-clock', key: 'limits' } as const, [], { shape: 'limits-1' })

// A chat this big turns keep-warm on by itself: a cold restart costs far more than a few pings.
const AUTO_TOKENS = 100_000
// Past this, answers start to slip, so the line offers a handoff.
const LONG_TOKENS = 250_000
// Keep-warm stops this long after the last reply, so a forgotten chat stops costing.
const CAP_MS = 2 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const WARM = '#e8873c'
const COLD = '#5aa9e6'
// The plan meter's colours: a light Claude crab for the 5-hour limit, a red heart for the week.
const CRAB_COLOR = '#f5b08f'
const CRAB_TIRED = '#c99a84'
const HEART_COLOR = '#e5484d'
const HEART_TIRED = '#a8474a'
const SPENT = '#8a8a8a'
// The used-up part of a meter: a grey shell the colour drains out of.
const SHELL = '#5e5e5e'
const INK = '#1c1c1c'
const LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: 'week', spend_limit: 'spend' }
const LIMIT_LONG_NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'weekly', spend_limit: 'spend' }

const PING_PROMPT = 'Keep-warm ping from the cache-clock mod, not a request. Reply with just: ok'

const BRIEF_PROMPT = `Write a handoff brief so a fresh chat can continue this work with nothing lost. It will be the first message of the new chat, read by Claude with no other context. Do not call tools; write only the brief, in Markdown, under these headings:

## Goal
What the person is working toward, and why.

## Where things stand
What is done, what is half done, and every decision made (with the reason when one was given).

## Files
Every file read, created or changed, by full path, with one line on what each is for and its current state.

## Tools, skills and sources
Connectors, skills, commands and links used, and what each was used for.

## Preferences and rules
Every instruction, correction and preference the person gave, in their words where possible.

## Open questions
Anything unresolved or waiting on the person.

## Next steps
Exactly where to pick up, in order.

Be specific and complete: names, paths, numbers and wording matter more than brevity.`

// Dollars per million tokens: input, output, and a cache read.
const PRICES: Array<[RegExp, { input: number; output: number; read: number }]> =
  [
    [/fable|mythos/, { input: 10, output: 50, read: 0.25 }],
    [/opus/, { input: 4, output: 20, read: 0.2 }],
    [/sonnet/, { input: 2, output: 10, read: 0.2 }],
    [/haiku/, { input: 0.1, output: 0.5, read: 0.01 }],
  ]

const priceOf = (model: string) =>
  PRICES.find(([match]) => match.test(model))?.[1] ?? { input: 4, output: 20, read: 0.2 }

// A cold message re-reads the chat at full price and writes it to the cache again:
// twice the input price for a one-hour cache, 1.25 times for a five-minute one.
const coldCost = (current: Chat, ttl: number): number =>
  (current.tokens / 1_000_000) * priceOf(current.model).input * (ttl >= HOUR ? 2 : 1.25)

const kilo = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : `${n}`

const money = (n: number): string => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`

const clock = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))

  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const timeOfDay = (at: number): string => {
  const d = new Date(at)
  const hour = d.getHours() % 12 || 12

  return `${hour}:${String(d.getMinutes()).padStart(2, '0')}${d.getHours() < 12 ? 'am' : 'pm'}`
}

// How long until a reset: 42m, 3h 12m, 5d 13h.
const span = (ms: number): string => {
  const m = Math.max(0, Math.round(ms / 60_000))

  return m >= 1440
    ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`
    : m >= 60
      ? `${Math.floor(m / 60)}h ${m % 60}m`
      : `${m}m`
}

// How the meter feels as a limit fills: excited, fine, tired, exhausted, then spent at 100%.
type Mood = 'excited' | 'fine' | 'tired' | 'exhausted' | 'spent'

const moodOf = (pct: number): Mood =>
  pct >= 100 ? 'spent' : pct >= 75 ? 'exhausted' : pct >= 50 ? 'tired' : pct >= 25 ? 'fine' : 'excited'

// Claude's mascot, as it appears on Claude Code's welcome screen.
const CRAB = [' ▐▛███▜▌', '▝▜█████▛▘', '  ▘▘ ▝▝']

// Which quarters of a cell each block character fills: top-left, top-right, bottom-left, bottom-right.
const QUARTERS: Record<string, [boolean, boolean, boolean, boolean]> = {
  '▘': [true, false, false, false],
  '▝': [false, true, false, false],
  '▌': [true, false, true, false],
  '▐': [false, true, false, true],
  '▛': [true, true, true, false],
  '▜': [true, true, false, true],
  '█': [true, true, true, true],
}

// The crab as pixels, each quarter 1 wide and 1.5 tall like a terminal cell: 18 by 9.
const CRAB_RECTS = CRAB.flatMap((line, row) =>
  [...line].flatMap((char, col) =>
    (QUARTERS[char] ?? []).flatMap((isOn, q) =>
      isOn ? [`<rect x="${col * 2 + (q % 2)}" y="${row * 3 + Math.floor(q / 2) * 1.5}" width="1" height="1.5"/>`] : [],
    ),
  ),
).join('')

// Where the crab's two eyes sit (the gaps in ▛ and ▜).
const EYES = [5, 12]

// A pixel heart, 7 by 6.
const HEART_RECTS = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...']
  .flatMap((line, y) => [...line].flatMap((cell, x) => (cell === 'X' ? [`<rect x="${x}" y="${y}" width="1" height="1"/>`] : [])))
  .join('')

const rect = (x: number, y: number, w: number, ht: number, fill: string) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${ht}" fill="${fill}"/>`

// A little four-point sparkle centred on x, y.
const sparkle = (x: number, y: number) => rect(x - 0.4, y - 1.2, 0.8, 2.4, '#ffd166') + rect(x - 1.2, y - 0.4, 2.4, 0.8, '#ffd166')

// A pixel "z", 2 wide, its top-left at x, y.
const zee = (x: number, y: number, size: number) =>
  rect(x, y, 2 * size, 0.5 * size, '#b0b0b0') + rect(x + 0.75 * size, y + 0.5 * size, 0.5 * size, 0.5 * size, '#b0b0b0') + rect(x, y + size, 2 * size, 0.5 * size, '#b0b0b0')

// A shape drawn faint, then solid below the line it has drained to: the more used, the lower the fill.
const drained = (shape: string, color: string, pct: number, top: number, height: number, width: number) => {
  const level = top + height * Math.min(1, Math.max(0, pct / 100))

  return (
    `<defs><clipPath id="left"><rect x="-4" y="${level}" width="${width + 8}" height="${height + 4}"/></clipPath></defs>` +
    `<g fill="${SHELL}">${shape}</g>` +
    `<g fill="${color}" clip-path="url(#left)">${shape}</g>`
  )
}

// The 5-hour meter: the crab drains from the top and gets wearier, spent with X eyes at 100%.
const crabMeterSvg = (pct: number): string => {
  const mood = moodOf(pct)
  const color = mood === 'spent' ? SPENT : mood === 'exhausted' ? CRAB_TIRED : CRAB_COLOR
  const eyes = EYES.map(x =>
    mood === 'excited' || mood === 'fine'
      ? rect(x, 1.5, 1, 1.5, INK)
      : mood === 'tired'
        ? rect(x, 1.5, 1, 0.75, color) + rect(x, 2.25, 1, 0.75, INK)
        : mood === 'exhausted'
          ? rect(x, 1.5, 1, 1.5, color) + rect(x - 0.2, 2.5, 1.4, 0.4, INK)
          : `<path d="M${x - 0.3} 1.4L${x + 1.3} 3.1M${x + 1.3} 1.4L${x - 0.3} 3.1" stroke="${INK}" stroke-width="0.45"/>`,
  ).join('')
  const extras =
    mood === 'excited'
      ? sparkle(-1.5, 0) + sparkle(19.5, 1)
      : mood === 'tired'
        ? rect(17.4, -1, 0.6, 0.6, '#7cc4ff') + rect(17, -0.4, 1.4, 1.6, '#7cc4ff')
        : mood === 'exhausted'
          ? zee(17.5, -3, 1.2)
          : mood === 'spent'
            ? zee(16.5, -2.5, 1.2) + zee(19.5, -4.8, 0.9)
            : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3.5 -5 26 14.5" shape-rendering="crispEdges">` +
    drained(CRAB_RECTS, color, pct, 0, 9, 18) +
    eyes +
    extras +
    `</svg>`
  )
}

// The weekly meter: a red heart that drains the same way, grey and cracked at 100%.
const heartMeterSvg = (pct: number): string => {
  const mood = moodOf(pct)
  const color = mood === 'spent' ? SPENT : mood === 'exhausted' ? HEART_TIRED : HEART_COLOR
  const extras =
    mood === 'excited'
      ? rect(1, 1, 1, 1, '#ffffff') + sparkle(7.6, -0.2)
      : mood === 'spent'
          ? `<path d="M3.6 0.6L3 2.2L4 3.4L3.4 5.4" fill="none" stroke="${INK}" stroke-width="0.4"/>`
          : ''

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1.5 -1.8 10 8.6" shape-rendering="crispEdges">` +
    drained(HEART_RECTS, color, pct, 0, 6, 7) +
    extras +
    `</svg>`
  )
}

// The terminal has no SVG: a tinted mini crab and a heart, outlined once spent.
const meterGlyph = (kind: string, pct: number): { glyph: string; color: string } => {
  const mood = moodOf(pct)
  const isHeart = kind !== 'five_hour'

  return {
    glyph: isHeart ? (mood === 'spent' ? '♡' : '♥') : mood === 'spent' ? '▐x█x▌' : '▐▛█▜▌',
    color: mood === 'spent' ? SPENT : isHeart ? (mood === 'exhausted' ? HEART_TIRED : HEART_COLOR) : mood === 'exhausted' ? CRAB_TIRED : CRAB_COLOR,
  }
}

// One plan limit in words: "5h 4% (resets 42m)". The weekly reset only shows once it is getting full.
const limitText = (limit: Limit, at: number): string => {
  const name = LIMIT_NAMES[limit.kind] ?? limit.kind
  const resetsIn = limit.resetsAt === undefined ? null : Date.parse(limit.resetsAt) - at
  const showsReset = resetsIn !== null && resetsIn > 0 && (limit.kind === 'five_hour' || limit.percentUsed >= 75)

  return `${name} ${Math.round(limit.percentUsed)}%${showsReset ? ` (resets ${span(resetsIn)})` : ''}`
}

const stamp = (at: number): string => {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

// The module's own running state; a reload starts it over.
const run = {
  // A subscription keeps the cache an hour; an API key, five minutes.
  ttl: HOUR,
  isTurnRunning: false,
  isPinging: false,
  isTicking: false,
  // The brief waiting for the fresh chat a handoff's /clear opens.
  pendingBrief: null as string | null,
  // Limits already warned about at 90%, by kind and reset time, so each window warns once.
  warned: new Set<string>(),
}

// Keeps the plan limits the engine reported, and warns once when one passes 90%.
const recordLimits = async ($: EngineInterface, reported: SessionRateLimit[]) => {
  const next: Limit[] = reported.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))
  await update($, limits, () => next)

  const at = await $.clock.now()

  for (const limit of next) {
    const id = `${limit.kind}@${limit.resetsAt ?? ''}`

    if (limit.percentUsed >= 90 && !run.warned.has(id)) {
      run.warned.add(id)
      const resetsIn = limit.resetsAt === undefined ? 0 : Date.parse(limit.resetsAt) - at
      $.ui.toast(
        `You've used ${Math.round(limit.percentUsed)}% of your ${LIMIT_LONG_NAMES[limit.kind] ?? limit.kind} limit${resetsIn > 0 ? `; it resets in ${span(resetsIn)}` : ''}.`,
      )
    }
  }
}

// Learns the cache's lifetime and starts the one-second clock, once, at the first reply.
const ensureTicking = async ($: EngineInterface) => {
  if (run.isTicking) {
    return
  }

  run.isTicking = true
  // API keys and cloud providers keep the cache five minutes; a Claude subscription, an hour.
  const kind = await $.session.identity().then(identity => identity.kind ?? 'claude.ai', () => 'claude.ai')
  run.ttl = /^(api-key|console|bedrock|vertex|foundry)$/.test(kind) ? 5 * 60 * 1000 : HOUR
  $.clock.every(1000, () => void tick($))
}

// Notes the chat as of a reply: its size, its model, and that it is warm from now.
const recordReply = async ($: EngineInterface, used: TurnUsage | undefined) => {
  await ensureTicking($)

  const at = await $.clock.now()
  // What the next message re-sends: this reply's input, cached and not, plus its output.
  const model = used?.model ?? (await $.session.model().catch(() => 'claude-opus'))
  const fromStep =
    used === undefined
      ? 0
      : used.input_tokens + used.cache_read_input_tokens + used.cache_creation_input_tokens + used.output_tokens
  const usage = await $.session.usage().catch(() => undefined)
  const tokens = usage?.context.tokens ?? fromStep

  if (usage !== undefined) {
    await recordLimits($, usage.rateLimits)
  }

  await update($, chat, () => ({ warmAt: at, tokens, model }))
  await update($, now, () => at)

  // Each reply starts a new break: keep-warm turns on by itself for a big chat.
  await update($, keepWarm, (): KeepWarm => ({
    mode: tokens >= AUTO_TOKENS ? 'auto' : 'off',
    until: at + CAP_MS,
    pings: 0,
  }))
}

// The clock's state in words, for /cacheclock.
const describe = async ($: EngineInterface): Promise<string> => {
  const current = await read($, chat)

  if (current === null) {
    return 'No reply yet in this chat, so nothing to time.'
  }

  const kw = await read($, keepWarm)
  const left = current.warmAt + run.ttl - (await $.clock.now())
  const size = `${kilo(current.tokens)} tokens on ${current.model}`
  const warmth =
    left > 0
      ? `Warm: cold in ${clock(left)} (${run.ttl >= HOUR ? '1-hour' : '5-minute'} cache).`
      : `Cold: your next message re-reads ${kilo(current.tokens)} tokens (~${money(coldCost(current, run.ttl))}).`
  const warming =
    kw.mode === 'off'
      ? 'Keep-warm is off.'
      : `Keep-warm is on${kw.mode === 'auto' ? ' (big chat)' : ''} until ${timeOfDay(kw.until)}, ${kw.pings} ping${kw.pings === 1 ? '' : 's'} so far.`

  const plan = await read($, limits)
  const at = await $.clock.now()
  const planText = plan.length === 0 ? '' : ` Plan: ${plan.map(limit => limitText(limit, at)).join(', ')}.`

  return `${warmth} ${size}. ${warming}${planText}`
}

// Pings ahead of the cache running out, more lead for the longer cache.
const leadOf = () => (run.ttl >= HOUR ? 3 * 60 * 1000 : 45 * 1000)


const ping = async ($: EngineInterface) => {
  run.isPinging = true

  try {
    const reply = await $.model.fork({ prompt: PING_PROMPT })
    const at = await $.clock.now()

    if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
      await update($, keepWarm, (kw): KeepWarm => ({ ...kw, mode: 'off' }))
      return
    }

    await update($, keepWarm, kw => ({ ...kw, pings: kw.pings + 1 }))

    if ('usage' in reply && reply.usage !== undefined) {
      await update($, chat, current => (current === null ? current : { ...current, warmAt: at }))
    }
  } finally {
    run.isPinging = false
  }
}

const tick = async ($: EngineInterface) => {
  const current = await read($, chat)

  if (current === null) {
    return
  }

  const at = await $.clock.now()
  await update($, now, () => at)

  const kw = await read($, keepWarm)

  if (kw.mode !== 'off' && at >= kw.until) {
    await update($, keepWarm, (k): KeepWarm => ({ ...k, mode: 'off' }))
    return
  }

  const isDue = at >= current.warmAt + run.ttl - leadOf() && at < current.warmAt + run.ttl

  if (kw.mode !== 'off' && isDue && !run.isTurnRunning && !run.isPinging) {
    await ping($)
  }
}

const fillBrief = ($: EngineInterface, tries: number) => {
  $.clock.after(400, () => {
    const brief = run.pendingBrief

    if (brief === null) {
      return
    }

    void $.prompt.fill({ text: brief }).then(filled => {
      if (filled.isFilled) {
        run.pendingBrief = null
        $.ui.toast('Fresh chat ready: the handoff brief is in the prompt box. Review it, then send.')
      } else if (tries > 1) {
        fillBrief($, tries - 1)
      } else {
        run.pendingBrief = null
        void $.ui.copy({ text: brief })
        $.ui.toast('Fresh chat ready: the handoff brief is on your clipboard. Paste it to continue.')
      }
    })
  })
}

const startHandoff = async ($: EngineInterface) => {
  if ((await read($, handoff)) === 'writing') {
    return
  }

  await update($, handoff, () => 'writing')
  const reply = await $.model.fork({ prompt: BRIEF_PROMPT })

  if (!reply.isAnswered) {
    await update($, handoff, () => 'failed')
    $.ui.toast(`Couldn't write the handoff brief (${reply.reason}). The chat is unchanged.`)
    return
  }

  // Keeps a copy in the project's .claude/handoffs folder; the handoff goes on without one.
  const at = await $.clock.now()
  const path = await $.session.cwd().then(
    cwd => `${cwd}/.claude/handoffs/handoff-${stamp(at)}.md`,
    () => null,
  )
  const saved = path !== null && (await $.fs.write(path, reply.text.trim()).then(() => true, () => false))
  const brief = `${reply.text.trim()}\n\n---\nContinued from an earlier chat.${saved ? ` Brief saved at ${path}.` : ''}`
  run.pendingBrief = brief
  await update($, handoff, () => 'idle')

  // Starts the fresh chat once this press has settled; session.end then fills the brief in.
  $.clock.after(0, () => {
    void $.command.run({ command: 'clear', args: '' }).catch(() => {
      run.pendingBrief = null
      void $.ui.copy({ text: brief })
      $.ui.toast('Brief copied to your clipboard. Start a new chat and paste it to continue.')
    })
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    await $.command.register({
      name: 'keepwarm',
      description: 'Keep this chat warm for the next 2 hours',
    })
    await $.command.register({
      name: 'cacheclock',
      description: 'Show how long until this chat goes cold, and keep-warm status',
    })
    await $.command.register({
      name: 'handoff',
      description: 'Write a detailed brief and continue in a fresh chat',
    })

    return result
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const current = await read($, chat)

    if (current === null) {
      return { text: 'Nothing to keep warm yet: the chat has no reply.' }
    }

    const until = (await $.clock.now()) + CAP_MS
    await update($, keepWarm, (kw): KeepWarm => ({ ...kw, mode: 'on', until }))

    return { text: `Keeping this chat warm until ${timeOfDay(until)}, or until you send your next message.` }
  })

  on('command.run', { command: 'cacheclock' }, async ($, e) => ({ text: await describe($) }))

  on('command.run', { command: 'handoff' }, async ($, e) => {
    void startHandoff($)

    return { text: 'Writing the handoff brief…' }
  })

  on('prompt.submit', async ($, e, next) => {
    run.isTurnRunning = true

    return next(e)
  }).catch(($, e, next) => next(e))

  // Each response on the main thread refreshes the cache, so the clock starts again there.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)

    if (e.agentId === undefined && response.usage !== null) {
      await recordReply($, response.usage)
    }

    return response
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId === undefined) {
      run.isTurnRunning = false
      // Its usage sums every request of the turn, so it is not the chat's size.
      await recordReply($, undefined)
    }

    return result
  })


  // The engine pushes the plan limits when one moves a whole point, between replies too.
  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) {
      await recordLimits($, e.rateLimits)
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      run.isTurnRunning = false
      await update($, chat, () => null)
      await update($, keepWarm, (): KeepWarm => ({ mode: 'off', until: 0, pings: 0 }))
      await update($, handoff, () => 'idle')

      if (run.pendingBrief !== null) {
        fillBrief($, 10)
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const current = await read($, chat)
    run.isTurnRunning = e.props.isWorking

    if (e.props.hasSurvey || e.props.isWorking || current === null) {
      return below
    }

    const kw = await read($, keepWarm)
    const state: Handoff = await read($, handoff)
    const at = Math.max(await read($, now), current.warmAt)
    const left = current.warmAt + run.ttl - at
    const isCold = left <= 0
    const isLong = current.tokens >= LONG_TOKENS
    const plan = await read($, limits)
    const { Box, Text, Button } = $.ui.resolve(e)

    // The plan limits as a crab (5 hours) and a heart (the week) that drain as they fill.
    const ui = $.ui.resolve(e)
    // The terminal's table names Svg but draws it as nothing, so it gets text glyphs.
    const Svg = e.surface !== 'terminal' && 'Svg' in ui ? ui.Svg : null
    const meter = plan.length === 0 ? null : (
      <Box key="meter" flexDirection="row" alignItems="center" gap={1} flexShrink={0}>
        {plan.map(limit => {
          const pct = Math.round(limit.percentUsed)
          const isCrab = limit.kind === 'five_hour'
          const alt = `${LIMIT_LONG_NAMES[limit.kind] ?? limit.kind} limit: ${limitText(limit, at).replace(/^\S+ /, '')}`

          if (Svg) {
            return (
              <Box key={`limit-${limit.kind}`} flexDirection="row" alignItems="center" flexShrink={0}>
                <Svg
                  source={isCrab ? crabMeterSvg(limit.percentUsed) : heartMeterSvg(limit.percentUsed)}
                  alt={alt}
                  width={isCrab ? 40 : 24}
                  height={22}
                />
                <Text dimColor>{` ${pct}%`}</Text>
              </Box>
            )
          }

          const { glyph, color } = meterGlyph(limit.kind, limit.percentUsed)

          return (
            <Box key={`limit-${limit.kind}`} flexDirection="row" flexShrink={0}>
              <Text color={color}>{glyph}</Text>
              <Text dimColor>{` ${pct}%`}</Text>
            </Box>
          )
        })}
      </Box>
    )

    const handOff = (
      <Button
        key="handoff"
        label={state === 'writing' ? 'Writing brief…' : 'Hand off'}
        onPress={() => void startHandoff($)}
      />
    )

    const line = isCold ? (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Box flexShrink={0}>
          <Text color={COLD}>❄ Cold</Text>
        </Box>
        <Text dimColor>
          · your next message re-reads {kilo(current.tokens)} tokens (~{money(coldCost(current, run.ttl))})
        </Text>
        {meter}
        {handOff}
      </Box>
    ) : (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Box flexShrink={0}>
          <Text color={WARM}>◔ Warm</Text>
        </Box>
        <Text dimColor>
          · cold in {clock(left)} · {kilo(current.tokens)} tokens
          {kw.mode === 'off'
            ? ''
            : ` · keep-warm on${kw.mode === 'auto' ? ' (big chat)' : ''} until ${timeOfDay(kw.until)}${kw.pings > 0 ? ` · ${kw.pings} ping${kw.pings === 1 ? '' : 's'}` : ''}`}
          {isLong ? ' · long chat, answers may slip' : ''}
        </Text>
        {meter}
        {kw.mode === 'off' ? (
          <Button
            key="warm"
            label="Keep warm"
            onPress={async () => {
              const until = (await $.clock.now()) + CAP_MS
              await update($, keepWarm, (k): KeepWarm => ({ ...k, mode: 'on', until }))
            }}
          />
        ) : (
          <Button
            key="stop"
            label="Stop"
            onPress={() => update($, keepWarm, (k): KeepWarm => ({ ...k, mode: 'off' }))}
          />
        )}
        {(isLong || state !== 'idle') && handOff}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {below ? below : null}
        {line}
      </Box>
    )
  })
}
