import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { Chat, Handoff, KeepWarm } from '../types'

const chat = atom({ plugin: 'cache-clock', key: 'chat' } as const, null, { shape: 'chat-1' })
const keepWarm = atom({ plugin: 'cache-clock', key: 'keepWarm' } as const, { mode: 'off', until: 0, pings: 0 }, { shape: 'keep-warm-1' })
const handoff = atom({ plugin: 'cache-clock', key: 'handoff' } as const, 'idle')
const now = atom({ plugin: 'cache-clock', key: 'now' } as const, 0)

// A chat this big turns keep-warm on by itself: a cold restart costs far more than a few pings.
const AUTO_TOKENS = 100_000
// Past this, answers start to slip, so the line offers a handoff.
const LONG_TOKENS = 250_000
// Keep-warm stops this long after the last reply, so a forgotten chat stops costing.
const CAP_MS = 2 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const WARM = '#e8873c'
const COLD = '#5aa9e6'

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
  const tokens = (await $.session.usage().then(usage => usage.context.tokens, () => undefined)) ?? fromStep

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

  return `${warmth} ${size}. ${warming}`
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
    const { Box, Text, Button } = $.ui.resolve(e)

    const handOff = (
      <Button
        key="handoff"
        label={state === 'writing' ? 'Writing brief…' : 'Hand off'}
        onPress={() => void startHandoff($)}
      />
    )

    const line = isCold ? (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text color={COLD}>❄ Cold</Text>
        <Text dimColor>
          · your next message re-reads {kilo(current.tokens)} tokens (~{money(coldCost(current, run.ttl))})
        </Text>
        {handOff}
      </Box>
    ) : (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text color={WARM}>◔ Warm</Text>
        <Text dimColor>
          · cold in {clock(left)} · {kilo(current.tokens)} tokens
          {kw.mode === 'off'
            ? ''
            : ` · keep-warm on${kw.mode === 'auto' ? ' (big chat)' : ''} until ${timeOfDay(kw.until)}${kw.pings > 0 ? ` · ${kw.pings} ping${kw.pings === 1 ? '' : 's'}` : ''}`}
          {isLong ? ' · long chat, answers may slip' : ''}
        </Text>
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
