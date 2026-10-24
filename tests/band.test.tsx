import { expect, mock, test } from 'claude-code/testing'

// Longer than a short reply, so the summary step runs (a short one is said as is).
const long = (text: string) => `${text} ${'There is more detail in the full reply here. '.repeat(4)}`

const BAND = {
  plugin: 'bob-mod-claude',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 40,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const PANE = {
  plugin: 'bob-mod-claude',
  component: 'Pane',
  requestId: 'bob',
  props: {
    title: 'Bob',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('Bob shows the prompt, then his one-line gist and the full answer', async ($, on) => {
  const clock = mock.clock(on)
  mock.store(on, { 'settings-v2': { isOn: true, isVoiceOn: false } })
  on('command.register', () => ({ value: { command: 'bob' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.write', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: 'Done: the orb is nicer.',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'make the orb nicer' })

  const working = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await working.find({ type: 'Text', text: /make the orb nicer/ }))?.text).toBe('make the orb nicer')
  await working.unmount()

  await $.turn.complete({
    answer: long('I made the orb nicer. It now glows.'),
    durationMs: 10,
    isAborted: false,
    turnId: 't1',
  })
  await clock.advance(30_000)

  for (const surface of ['desktop', 'terminal'] as const) {
    const done = await $.ui.mount({ ...BAND, surface })
    expect((await done.find({ type: 'Text', text: /^DONE$/ }))?.text).toBe('DONE')
    expect((await done.find({ type: 'Text', text: /^the orb is nicer\.$/ }))?.text).toBe('the orb is nicer.')
    expect((await done.find({ type: 'Text', text: /^make the orb nicer$/ }))?.text).toBe('make the orb nicer')
    expect(await done.find({ type: 'Text', text: /It now glows/ })).toBeUndefined()
    await done.unmount()
  }

  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await pane.find({ type: 'Text', text: /^the orb is nicer\.$/ }))?.text).toBe('the orb is nicer.')
  await pane.unmount()
})

test('while Claude waits on a question, the panel shows it', async ($, on) => {
  mock.clock(on)
  mock.store(on, { 'settings-v2': { isOn: true, isVoiceOn: false } })
  on('command.register', () => ({ value: { command: 'bob' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.write', () => ({ value: undefined }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  let shown: string | undefined
  on('tool.call', async () => {
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    shown = (await band.find({ type: 'Text', text: /Which banana/ }))?.text
    await band.unmount()
    return { result: { answers: {} } }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'find me a banana shop' })
  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [
      {
        question: 'Which banana shop?',
        header: 'Shop',
        multiSelect: false,
        options: [
          { label: 'Market', description: 'Talad Bang Na' },
          { label: 'Supermarket', description: 'Tops' },
        ],
      },
    ],
  })

  expect(shown).toBe('Which banana shop?')
  const after = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: /Which banana/ })).toBeUndefined()
  await after.unmount()
})
