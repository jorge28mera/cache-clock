import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'cache-clock',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const reply = (tokens: number) => ({
  reason: 'answer' as const,
  answer: 'Done.',
  durationMs: 1000,
  isAborted: false,
  turnId: 't1',
  usage: {
    model: 'claude-opus-5-5',
    input_tokens: 10,
    output_tokens: 90,
    cache_read_input_tokens: tokens * 20,
    cache_creation_input_tokens: 0,
  },
})

test('a big chat keeps itself warm with a ping before it goes cold', async ($, on) => {
  const size = 180_000
  const time = mock.clock(on, { now: 1_000_000 })
  let forks = 0
  on('model.fork', () => {
    forks += 1
    return {
      value: {
        isAnswered: true,
        text: 'ok',
        usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 180_000, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('turn.complete', () => ({ text: 'Done.' }))
  // An API key: the cache lasts five minutes.
  on('session.identity', () => ({ value: { kind: 'api-key', isVerified: false } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: size, window: 1_000_000 }, rateLimits: [] } }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  await $.turn.complete(reply(180_000))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Warm/ }))?.text).toBe('◔ Warm')
    expect((await ui.find({ type: 'Text', text: /keep-warm on \(big chat\)/ }))).toBeTruthy()
    expect(await ui.find({ key: 'stop' })).toBeTruthy()
    await ui.unmount()
  }

  await time.advance(5 * 60 * 1000 - 30 * 1000)
  expect(forks).toBe(1)

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /1 ping/ }))).toBeTruthy()
  await ui.unmount()
})

test('a small chat goes cold and offers a handoff', async ($, on) => {
  const size = 40_000
  const time = mock.clock(on, { now: 1_000_000 })
  let forks = 0
  on('model.fork', () => {
    forks += 1
    return { value: { isAnswered: true, text: 'ok', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('turn.complete', () => ({ text: 'Done.' }))
  // An API key: the cache lasts five minutes.
  on('session.identity', () => ({ value: { kind: 'api-key', isVerified: false } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: size, window: 1_000_000 }, rateLimits: [] } }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  await $.turn.complete(reply(40_000))

  const warm = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await warm.find({ key: 'warm' })).toBeTruthy()
  await warm.unmount()

  await time.advance(6 * 60 * 1000)
  expect(forks).toBe(0)

  const cold = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await cold.find({ type: 'Text', text: /Cold/ }))?.text).toBe('❄ Cold')
  expect((await cold.find({ type: 'Text', text: /re-reads 40k tokens/ }))).toBeTruthy()
  expect(await cold.find({ key: 'handoff' })).toBeTruthy()
  await cold.unmount()
})

test('a handoff writes the brief and starts a fresh chat', async ($, on) => {
  const size = 300_000
  const time = mock.clock(on, { now: 1_000_000 })
  let cleared = 0
  on('model.fork', () => ({
    value: {
      isAnswered: true,
      text: '## Goal\nShip the reel.',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
  }))
  on('turn.complete', () => ({ text: 'Done.' }))
  // An API key: the cache lasts five minutes.
  on('session.identity', () => ({ value: { kind: 'api-key', isVerified: false } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: size, window: 1_000_000 }, rateLimits: [] } }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  on('command.run', { command: 'clear' }, () => {
    cleared += 1
    return { text: '' }
  })

  await $.turn.complete(reply(300_000))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /long chat/ }))).toBeTruthy()
  await ui.press({ key: 'handoff' })
  await time.settle()
  await ui.unmount()

  expect(cleared).toBe(1)
})

test('the line shows plan limits as a crab and a heart and follows pushed updates', async ($, on) => {
  const start = Date.parse('2026-11-04T12:00:00Z')
  mock.clock(on, { now: start })
  const toasts: string[] = []
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('ui.toast', (_, e) => {
    toasts.push(String(e.text))
    return { value: undefined }
  })
  on('turn.complete', () => ({ text: 'Done.' }))
  on('session.identity', () => ({ value: { kind: 'claude.ai', isVerified: true } }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 20_000, window: 1_000_000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 92, resetsAt: '2026-11-04T12:42:00Z' },
        { kind: 'seven_day', percentUsed: 3, resetsAt: '2026-11-10T17:00:00Z' },
      ],
    },
  }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  await $.turn.complete(reply(20_000))

  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const crab = await ui.find({ type: 'Svg' })
  expect(String(crab?.props.alt)).toBe('5-hour limit: 92% (resets 42m)')
  expect(await ui.find({ type: 'Text', text: /92%/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /3%/ })).toBeTruthy()
  await ui.unmount()
  expect(toasts).toEqual(["You've used 92% of your 5-hour limit; it resets in 42m."])

  await $.session.measure({
    context: { tokens: 20_000, window: 1_000_000 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 40, resetsAt: '2026-11-04T12:42:00Z' }],
    changed: ['rateLimits'],
  })

  const later = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await later.find({ type: 'Text', text: /▐▛█▜▌/ })).toBeTruthy()
  expect(await later.find({ type: 'Text', text: /40%/ })).toBeTruthy()
  expect(await later.find({ type: 'Text', text: /♥/ })).toBeFalsy()
  await later.unmount()
})
