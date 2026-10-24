import { expect, mock, test } from 'claude-code/testing'

// Longer than a short reply, so the summary step runs (a short one is said as is).
const long = (text: string) => `${text} ${'There is more detail in the full reply here. '.repeat(4)}`
import type { On } from 'claude-code'

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

const PCM_TONE = (() => {
  // 0.2 s of quiet, 0.6 s of tone, 0.2 s of quiet, as OpenAI pads a take.
  const samples = 24000
  const bytes = new Uint8Array(samples * 2)
  const view = new DataView(bytes.buffer)
  for (let at = 0; at < samples; at++) {
    const isTone = at > 4800 && at < 19200
    view.setInt16(at * 2, isTone ? Math.round(6000 * Math.sin(at / 4)) : 0, true)
  }
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
})()

type Boot = {
  voice: boolean
  key?: boolean
  gist?: string
  refuses?: string
  live?: boolean
  stuck?: boolean
  heard?: { word: string; start: number }[]
  // What the streamed voice fails with, when it fails.
  streamError?: string
  // How long the shared voice lock stays taken by another chat.
  lockedMs?: number
  // How long the app takes to accept a message.
  promptDelayMs?: number
  // The voice picked with /bob mac, normal or live; most tests run on the live one, null leaves it unpicked.
  engine?: 'mac' | 'normal' | 'live' | null
}

// A session with Bob loaded and everything beneath him stood in for: what he
// plays, runs and fetches is recorded.
function boot(
  on: On,
  { voice, key = false, gist = 'Done: all set.', refuses, live = false, stuck = false, heard, streamError, lockedMs = 0, promptDelayMs = 0, engine = 'live' }: Boot,
) {
  const clock = mock.clock(on)
  mock.store(on, { 'settings-v2': { isOn: true, isVoiceOn: voice, ...(engine === null ? {} : { voiceEngine: engine }) } })
  mock.env(on, {})
  const sounds: string[] = []
  const runs: string[][] = []
  const fetches: string[] = []
  const prompts: string[] = []
  const written = new Map<string, string>()
  const agents: { id: string; description: string; type: string; status: string }[] = []
  on('agent.list', () => ({ value: agents as never }))
  on('command.register', () => ({ value: { command: 'bob' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.write', (_, e) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) =>
    key && String(e.path).endsWith('openai.env')
      ? { value: 'OPENAI_API_KEY=sk-test-0000000000000000000000' }
      : { value: '' },
  )
  on('prompt.submit', async (_, e) => {
    if (promptDelayMs > 0) await clock.sleep(promptDelayMs)
    prompts.push(e.text)
    return { text: e.text }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // The app's own permission dialog and failure report, which decide nothing here.
  on('classic.PermissionRequest', () => ({}))
  on('classic.StopFailure', () => ({}))
  on('audio.play', (_, e) => {
    sounds.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('process.run', async (_, e) => {
    runs.push([...e.argv, JSON.stringify(e)])
    const script = String(e.argv[2] ?? '')
    // The panel's answer: the wait ends once a button writes the answer file.
    const file = /f='([^']+answer-[^']+)'/.exec(script)?.[1]
    if (file !== undefined) {
      while (!written.has(file)) await clock.sleep(100)
      return { value: { exitCode: 0, stdout: written.get(file) ?? '', stderr: '' } }
    }
    // No voice of this chat left playing from before.
    if (e.argv[0] === 'pgrep') return { value: { exitCode: 1, stdout: '', stderr: '' } }
    if (e.argv[3] === 'voice-lock') return { value: { exitCode: clock.now() < lockedMs ? 1 : 0, stdout: '', stderr: '' } }
    if (e.argv.some(arg => String(arg).endsWith('realtime-voice.mjs'))) {
      if (stuck) await clock.sleep(120_000)
      return live
        ? {
            value: {
              exitCode: 0,
              // The live voice writes its take to a file and prints a short note.
              stdout: JSON.stringify({
                ms: 1000,
                words: (heard ?? []).map(one => ({ word: one.word, at: one.start * 1000 })),
                voiced: [[0, 1000]],
              }),
              stderr: '',
            },
          }
        : { value: { exitCode: 1, stdout: '', stderr: 'no OpenAI key' } }
    }
    // With word times given, the player lasts as long as a real take would.
    if (heard && e.argv.includes('/usr/bin/afplay')) await clock.sleep(4000)
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  // The streamed live voice: reports the first sound, the word times, then
  // the end, as realtime-stream.mjs does; fails when the live voice is off.
  on('process.spawn', async function* (_, e) {
    runs.push([...e.argv, JSON.stringify(e)])
    if (!e.argv.some(arg => String(arg).endsWith('realtime-stream.mjs'))) return { value: { code: 0, signal: null } }
    if (stuck) await clock.sleep(120_000)
    if (!live) {
      yield { stream: 'stderr' as const, text: `${streamError ?? 'no OpenAI key'}\n` }
      return { value: { code: 1, signal: null } }
    }
    yield { stream: 'stdout' as const, text: '{"event":"start"}\n' }
    const words = (heard ?? []).map(one => ({ word: one.word, at: one.start * 1000 }))
    yield { stream: 'stdout' as const, text: `${JSON.stringify({ event: 'words', ms: 4000, words })}\n` }
    await clock.sleep(4000)
    yield { stream: 'stdout' as const, text: '{"event":"end"}\n' }
    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', async (_, e) => {
    if (stuck) await clock.sleep(120_000)
    const asked = String(JSON.parse(String(e.init?.body ?? '{}')).voice)
    fetches.push(`${String(e.url)} ${asked}`)
    if (asked === refuses) {
      return { value: { status: 400, ok: false, headers: {}, text: `{"error":{"message":"Invalid voice: ${asked}"}}` } }
    }
    return {
      value: {
        status: 200,
        ok: true,
        headers: {},
        text: `data: {"type":"speech.audio.delta","audio":"${PCM_TONE}"}\n\ndata: [DONE]\n\n`,
      },
    }
  })
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: gist,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  return { clock, sounds, runs, fetches, prompts, agents }
}

const says = (text: string) => ({
  message: { type: 'assistant' as const, role: 'assistant' as const, content: [{ type: 'text' as const, text }] },
  door: 'response' as const,
  origin: { kind: 'model' as const, model: 'test' },
  uuid: `u-${text.length}`,
})

test('1. captions: one headline per message, highlighted word by word', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'check the files' })
  await $.session.append(says('Checking the files now. This second sentence stays in the chat.'))
  await clock.advance(400)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^Checking$/ }))?.text).toBe('Checking')
  expect(await band.find({ type: 'Text', text: /second sentence/ })).toBeUndefined()
  const lit = (await band.findAll({ type: 'Box' })).filter(one => one.props.backgroundColor !== undefined)
  expect(lit.length).toBe(1)
  await band.unmount()
})

test('2. the closing line is spoken by the live voice alone, from its ready file', async ($, on) => {
  const { clock, runs, fetches } = boot(on, { voice: true, key: true, live: true, gist: 'Done: all set.\nSay: Hello there, Claude speaking.' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hello' })
  await $.session.append(says('Working on it.'))
  await $.turn.complete({ answer: long('Working on it.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(10_000)

  expect(runs.some(argv => argv.some(arg => arg.endsWith('realtime-stream.mjs')))).toBe(true)
  expect(fetches).toHaveLength(0)
  expect(runs.some(argv => argv[0] === 'say')).toBe(false)
})

test('3. no key: the Mac voice (a man\'s) speaks the closing line', async ($, on) => {
  const { clock, runs, fetches } = boot(on, { voice: true, key: false, gist: 'Done: all set.\nSay: Hello there, Claude speaking.' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hello' })
  await $.session.append(says('Working on it.'))
  await $.turn.complete({ answer: long('Working on it.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(20_000)

  expect(fetches).toHaveLength(0)
  expect(runs.find(argv => argv[0] === 'say')?.slice(1, 3)).toEqual(['-v', 'Daniel'])
})

for (const [gist, tag] of [
  ['Question: Which station are you near?', 'QUESTION FOR YOU'],
  ['Needs you: Paste the key, then save.', 'NEEDS YOU'],
  ['Done: The panel is simpler.', 'DONE'],
] as const) {
  test(`4. summary card: ${tag} tag, one line, your message`, async ($, on) => {
    const { clock } = boot(on, { voice: false, gist })
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await $.prompt.submit({ text: 'my question' })
    await $.session.append(says('Here is the answer.'))
    await $.turn.complete({ answer: long('Here is the answer.'), durationMs: 5, isAborted: false, turnId: 't' })
    await clock.advance(30_000)

    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    expect((await band.find({ type: 'Text', text: tag }))?.text).toBe(tag)
    expect((await band.find({ type: 'Text', text: gist.replace(/^[^:]+:\s*/, '') }))?.text).toBe(
      gist.replace(/^[^:]+:\s*/, ''),
    )
    expect((await band.find({ type: 'Text', text: /^my question$/ }))?.text).toBe('my question')
    await band.unmount()
  })
}

test('5. status line: what Claude is doing, with Thinking and Cooking taking turns', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  let seen: string | undefined
  on('tool.call', async () => {
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    seen = (await band.find({ type: 'Text', text: /^Reading / }))?.text
    await band.unmount()
    return { result: { file: { content: '' } } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'read it' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/register.tsx' })
  expect(seen).toBe('Reading register.tsx')

  const words = new Set<string>()
  for (let at = 0; at < 4; at++) {
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const word = (await band.find({ type: 'Text', text: /^(Thinking|Cooking)$/ }))?.text
    if (word) words.add(word)
    await band.unmount()
    await clock.advance(3000)
  }
  expect([...words].sort()).toEqual(['Cooking', 'Thinking'])
})

test('6. sounds: send, heartbeat while working, finish sound after the last word', async ($, on) => {
  const { clock, sounds } = boot(on, { voice: true, gist: 'Question: Which one?' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'go' })
  expect(sounds.some(one => one.includes('think.wav'))).toBe(true)

  await clock.advance(12_000)
  expect(sounds.some(one => one.includes('heartbeat.wav'))).toBe(true)

  await $.session.append(says('All done here.'))
  await $.turn.complete({ answer: long('All done here.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)
  const last = sounds.at(-1) ?? ''
  expect(last.includes('ask.wav')).toBe(true)
})

test('7. 🔇 mutes every sound and stops the voice', async ($, on) => {
  const { clock, sounds, runs } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'voice' })
  await band.unmount()

  sounds.length = 0
  runs.length = 0
  await $.prompt.submit({ text: 'go' })
  await $.session.append(says('Muted line here.'))
  await clock.advance(15_000)
  expect(sounds).toHaveLength(0)
  expect(runs.some(argv => argv[0] === 'say' || argv.includes('/usr/bin/afplay'))).toBe(false)
})

test('8. buttons: compact, hide and bring back, side panel', async ($, on) => {
  boot(on, { voice: false })
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'pane' })
  expect(opened).toContain('bob')
  await band.press({ key: 'off' })
  expect((await band.find({ key: 'show-bob' }))?.props.label).toBe('✻ Claude')
  await band.press({ key: 'show-bob' })
  expect(await band.find({ key: 'voice' })).toBeDefined()
  await band.unmount()
})

test('9. /bob command', async ($, on) => {
  boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const toggled = await $.command.run({ command: 'bob', args: 'voice' })
  expect(JSON.stringify(toggled)).toContain('Voice off')
  const status = await $.command.run({ command: 'bob', args: '' })
  expect(JSON.stringify(status)).toContain('Captions on, voice off')
})

test('10. the chat row Bob is still saying stays one quiet line', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'go' })
  await $.session.append(says('A long reply that Bob is about to say out loud.'))
  await clock.advance(100)
  const row = await $.ui.mount({
    plugin: 'bob-mod-claude',
    component: 'AssistantMessage',
    requestId: 'm1',
    surface: 'desktop',
    props: { text: 'A long reply that Bob is about to say out loud.', isFirstOfReply: true },
  })
  expect((await row.find({ type: 'Text', text: /Claude is saying this/ }))?.text).toBe('· Claude is saying this…')
  await row.unmount()
})

test('11. fix: a reply saved by the older Bob no longer shows an empty QUESTION FOR YOU', async ($, on) => {
  boot(on, { voice: false })
  // What the older Bob saved: a finished reply with no `waiting` or `choice` at all.
  const older = {
    id: 7, lines: [{ words: ['Done:', 'all', 'set.'], sentence: 0 }], line: 1, word: -1,
    blocks: [{ text: 'All set.', end: 1 }], isWorking: false, isShowingAll: false,
    activity: 'Thinking', gist: 'Done: all set.', points: [], pointAt: 0, isFullAnswer: false,
    plan: [], steps: [], seconds: 12, prompt: 'older prompt',
  }
  on('state.get', ($, e, next) =>
    e.plugin === 'bob-mod-claude' && e.key === 'reply' ? { value: { value: older, version: 1 } } : next(e),
  )
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: 'QUESTION FOR YOU' })).toBeUndefined()
  expect((await band.find({ type: 'Text', text: 'DONE' }))?.text).toBe('DONE')
  await band.unmount()
})

test('12. fix: with the side panel open, the summary still shows under the orb', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const first = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await first.press({ key: 'pane' })
  await first.unmount()

  await $.prompt.submit({ text: 'my question' })
  await $.session.append(says('Here is the answer.'))
  await $.turn.complete({ answer: long('Here is the answer.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'all set.' }))?.text).toBe('all set.')
  await band.unmount()
})

test('13. a next-step question goes to Bob\'s panel, never the app\'s box, and its buttons answer it', async ($, on) => {
  const { clock, prompts: sent } = boot(on, { voice: false })
  const reached: Record<string, unknown>[] = []
  on('tool.call', (_, e) => {
    reached.push({ ...e })
    return { result: {} }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'test bob' })
  await $.session.append(says('Everything passes.'))
  await $.tool.call({
    tool: 'mcp__ccd_turn__wrap_up',
    recap: 'All pass.',
    ask: 'Should I fix the mid-sentence start?',
    actions: [{ label: 'Yes, fix it', message: 'Yes, fix Bob starting mid-sentence.' }, { label: 'Not now' }],
  })
  await $.turn.complete({ answer: long('Everything passes.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  // The app is never asked for its box: no question, no buttons reach it.
  const wrapUp = reached.find(one => one.tool === 'mcp__ccd_turn__wrap_up')
  expect(wrapUp?.recap).toBe('All pass.')
  expect(wrapUp?.ask).toBeUndefined()
  expect(wrapUp?.actions).toBeUndefined()

  const band = await $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, hasSurvey: true } })
  expect((await band.find({ type: 'Text', text: 'QUESTION FOR YOU' }))?.text).toBe('QUESTION FOR YOU')
  expect((await band.find({ type: 'Text', text: /mid-sentence start/ }))?.text).toBe(
    'Should I fix the mid-sentence start?',
  )
  expect(String((await band.find({ key: 'choice1' }))?.props.label).trim()).toBe('Not now')
  await band.press({ key: 'choice0' })
  expect(sent).toContain('Yes, fix Bob starting mid-sentence.')
  await band.unmount()
})

test('14. a question: Bob finishes his line, dings, then says "Question for you" and reads it', async ($, on) => {
  const { clock, sounds, runs } = boot(on, { voice: true })
  let order: string[] = []
  on('tool.call', async () => {
    await clock.advance(20_000)
    order = [
      ...sounds.map(one => (one.includes('ask.wav') ? 'ding' : 'sound')),
      ...runs.filter(argv => argv[0] === 'say').map(argv => (argv.at(-1)?.includes('Question for you') ? 'question' : 'line')),
    ]
    return { result: { answers: {} } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'pick for me' })
  await $.session.append(says('Let me ask you something first.'))
  await $.tool.call({
    tool: 'AskUserQuestion',
    questions: [{ question: 'Market or supermarket?', header: 'Shop', multiSelect: false, options: [
      { label: 'Market', description: 'Talad Bang Na' }, { label: 'Supermarket', description: 'Tops' },
    ] }],
  })
  expect(order).toContain('ding')
  expect(order).toContain('question')
  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  expect(said.findIndex(one => one.includes('Let me ask'))).toBeLessThan(said.findIndex(one => one.includes('Question for you')))
})

test('15. Bob stays in his spot: a question never moves him to the side panel', async ($, on) => {
  const { clock } = boot(on, { voice: false, gist: 'Question: Which shop do you want?' })
  const opened: string[] = []
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'find a shop' })
  await $.session.append(says('Two good shops nearby.'))
  await $.turn.complete({ answer: long('Two good shops nearby. Which shop do you want?'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)
  expect(opened).toHaveLength(0)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'QUESTION FOR YOU' }))?.text).toBe('QUESTION FOR YOU')
  expect((await band.find({ type: 'Text', text: 'Which shop do you want?' }))?.text).toBe('Which shop do you want?')
  await band.unmount()
})

test('16. a question with choices: buttons appear once Bob is done talking, and a click sends the answer', async ($, on) => {
  const { clock, prompts } = boot(on, {
    voice: false,
    gist: 'Question: Which word should Bob add?\n> Brewing\n> Plotting\n> Simmering',
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'add a word' })
  await $.session.append(says('Which one should I add: Brewing, Plotting or Simmering?'))
  await $.turn.complete({
    answer: long('Which one should I add: Brewing, Plotting or Simmering?'),
    durationMs: 5,
    isAborted: false,
    turnId: 't',
  })
  await clock.advance(1_500)
  const talking = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await talking.find({ key: 'choice0' })).toBeUndefined()
  await talking.unmount()

  await clock.advance(30_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'QUESTION FOR YOU' }))?.text).toBe('QUESTION FOR YOU')
  expect((await band.find({ type: 'Text', text: 'Which word should Bob add?' }))?.text).toBe('Which word should Bob add?')
  expect((await band.findAll({ type: 'Button' })).map(one => String(one.props.label).trim())).toEqual(
    expect.arrayContaining(['Brewing', 'Plotting', 'Simmering']),
  )
  await band.press({ key: 'choice1' })
  expect(prompts.at(-1)).toBe('Plotting')
  // The click counts as sent at once: the panel is already on the new reply,
  // your answer as your message and Claude thinking.
  expect((await band.find({ type: 'Text', text: /^Plotting$/ }))?.text).toBe('Plotting')
  expect((await band.find({ type: 'Text', text: /^(Thinking|Cooking)$/ }))?.text).toMatch(/Thinking|Cooking/)
  expect(await band.find({ key: 'choice1' })).toBeUndefined()
  expect(prompts.filter(one => one === 'Plotting')).toHaveLength(1)
  await band.unmount()
})

test('17. if the live voice fails, the line shows silently: no second voice, nothing paid twice', async ($, on) => {
  const { clock, runs, fetches } = boot(on, { voice: true, key: true, live: false, gist: 'Done: all set.\nSay: Hello there, Claude speaking.' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hello' })
  await $.session.append(says('Working on it.'))
  await $.turn.complete({ answer: long('Working on it.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  expect(runs.filter(argv => argv.some(arg => arg.endsWith('realtime-stream.mjs'))).length).toBeGreaterThan(0)
  expect(fetches).toHaveLength(0)
  expect(runs.some(argv => argv[0] === 'say' || argv.includes('/usr/bin/afplay'))).toBe(false)
})

test('18. /bob voices plays the five male voices; /bob voice echo switches to it', async ($, on) => {
  const { clock, runs, fetches } = boot(on, { voice: true, key: true })
  on('ui.toast', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.command.run({ command: 'bob', args: 'voices' })
  await clock.advance(20_000)
  expect(fetches.map(one => one.split(' ')[1])).toEqual(['ash', 'echo', 'ballad', 'verse', 'cedar'])
  expect(runs.filter(argv => argv.includes('/usr/bin/afplay'))).toHaveLength(5)

  const switched = await $.command.run({ command: 'bob', args: 'voice echo' })
  expect(JSON.stringify(switched)).toContain('Claude now speaks in the echo voice')
  runs.length = 0
  await $.prompt.submit({ text: 'hello' })
  await $.session.append(says('Working on it.'))
  await $.turn.complete({ answer: long('Working on it.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(6000)
  const helper = runs.find(argv => argv[0] !== 'pgrep' && argv.some(arg => arg.endsWith('realtime-stream.mjs')))
  expect(helper?.[3]).toBe('echo')  // [env, node, helper, voice, …]
})

test('19. the live voice runs with the picked voice, model and style', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true, key: true, live: true, gist: 'Done: all set.\nSay: Hello there, Claude speaking.' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hello' })
  await $.session.append(says('Working on it.'))
  await $.turn.complete({ answer: long('Working on it.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(6000)

  const helper = runs.find(argv => argv[0] !== 'pgrep' && argv.some(arg => arg.endsWith('realtime-stream.mjs')))
  expect(helper?.[2]).toMatch(/helpers\/realtime-stream\.mjs$/)
  expect(helper?.slice(3, 6)).toEqual(['ash', 'gpt-realtime-2.1', 'narrator'])
})

test('20. Bob says what the reply means, then the question, never just a filler opener', async ($, on) => {
  const { clock, runs } = boot(on, {
    voice: true,
    gist: [
      'Question: Make the fake signup page?',
      'Say: For your video, a tiny fake website with one Sign up button that changes color while you watch.',
      '> Yes',
      '> No',
    ].join('\n'),
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'which demo page' })
  const reply = "Sorry, I'll keep it simple. The demo page would be a tiny fake website. Should I make it?"
  await $.session.append(says(reply))
  await $.turn.complete({ answer: long(reply), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(60_000)

  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  const meaning = said.findIndex(one => one.includes('tiny fake website with one Sign up button'))
  const question = said.findIndex(one => one.includes('Question for you. Make the fake signup page?'))
  expect(meaning).toBeGreaterThanOrEqual(0)
  expect(question).toBeGreaterThan(meaning)
  expect(said.some(one => one.includes("I'll keep it simple"))).toBe(false)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /tiny fake website/ }))?.text).toContain('Sign up button')
  expect((await band.find({ type: 'Text', text: 'Make the fake signup page?' }))?.text).toBe('Make the fake signup page?')
  await band.unmount()
})

test('21. when Claude goes back to work after a reply ended, the panel shows thinking, not idle', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  let during: string | undefined
  on('tool.call', async () => {
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    during = (await band.find({ type: 'Text', text: /^Reading / }))?.text
    expect(await band.find({ type: 'Text', text: 'DONE' })).toBeUndefined()
    await band.unmount()
    return { result: { file: { content: '' } } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'fix it' })
  await $.session.append(says('Fixed the first part.'))
  await $.turn.complete({ answer: long('Fixed the first part.'), durationMs: 5, isAborted: false, turnId: 't1' })
  await clock.advance(30_000)

  const idle = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await idle.find({ type: 'Text', text: 'DONE' }))?.text).toBe('DONE')
  await idle.unmount()

  // A stop hook sends Claude back to work: no new prompt, just more tools.
  await $.tool.call({ tool: 'Read', file_path: '/repo/app.ts' })
  expect(during).toBe('Reading app.ts')
})

test('22. if OpenAI answers nothing at all, the line shows silently: never a different voice', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true, key: true, stuck: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hello' })
  await $.session.append(says('Hello there, Claude speaking.'))
  await clock.advance(20_000)
  expect(runs.some(argv => argv[0] === 'say')).toBe(false)
})

test('23. a long task list shows at most 6 rows, keeping the step under way in view', async ($, on) => {
  boot(on, { voice: false })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'do nine things' })
  const items = Array.from({ length: 9 }, (_, at) => ({
    content: `Step ${at + 1}`,
    status: at < 6 ? 'completed' : at === 6 ? 'in_progress' : 'pending',
  }))
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items, scope: 'first_task' })

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const rows = (await band.findAll({ type: 'Text', text: /^Step \d$/ })).map(one => one.text)
  expect(rows).toHaveLength(6)
  expect(rows).toContain('Step 7')
  expect(rows[0]).toBe('Step 4')
  await band.unmount()
})

test('24. the highlight lands on each word when it is actually spoken', async ($, on) => {
  const { clock } = boot(on, {
    voice: true,
    key: true,
    live: true,
    gist: 'Done: all set.\nSay: Hello there, Claude speaking.',
    heard: [
      { word: 'Hello', start: 0.2 },
      { word: 'there', start: 1.2 },
      { word: 'Claude', start: 2.2 },
      { word: 'speaking', start: 3.2 },
    ],
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hello' })
  await $.session.append(says('Working on it.'))
  await $.turn.complete({ answer: long('Working on it.'), durationMs: 5, isAborted: false, turnId: 't' })

  const litAt: Record<string, number> = {}
  for (let step = 0; step < 80; step++) {
    await clock.advance(100)
    const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const lit = (await band.findAll({ type: 'Box' })).find(one => one.props.backgroundColor !== undefined && one.key?.startsWith('w'))
    if (lit?.key && litAt[lit.key] === undefined) litAt[lit.key] = clock.now()
    await band.unmount()
  }
  const gaps = [litAt.w1! - litAt.w0!, litAt.w2! - litAt.w1!, litAt.w3! - litAt.w2!]
  for (const gap of gaps) {
    expect(gap).toBeGreaterThanOrEqual(900)
    expect(gap).toBeLessThanOrEqual(1100)
  }
})

test('25. between finishing the work and starting to talk, the panel says it is putting it into words', async ($, on) => {
  const { clock } = boot(on, { voice: true, key: true, stuck: true, gist: 'Done: the helicopter is gold.' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'make it gold' })
  await $.session.append(says('Made the helicopter gold.'))
  await $.turn.complete({ answer: long('Made the helicopter gold.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(2_000)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /Putting it into words/ }))?.text).toBe('Putting it into words…')
  expect(await band.find({ type: 'Text', text: 'DONE' })).toBeUndefined()
  await band.unmount()
})

test('26. a short reply is said word for word, its question last, with no summary wait', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'make a yellow heli' })
  const reply = "Yellow gunship's ready, minigun and all. Want it in the plaza?"
  await $.session.append(says(reply))
  await $.turn.complete({ answer: reply, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  const first = said.findIndex(one => one.includes("Yellow gunship's ready, minigun and all."))
  const question = said.findIndex(one => one.includes('Question for you. Want it in the plaza?'))
  expect(first).toBeGreaterThanOrEqual(0)
  expect(question).toBeGreaterThan(first)
})

test('27. a one-line question is spoken once, as written, with no "Question for you" in front', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hi' })
  const reply = 'Hi, how can I help you today?'
  await $.session.append(says(reply))
  await $.turn.complete({ answer: reply, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  expect(said.filter(one => one.includes('Hi, how can I help you today?'))).toHaveLength(1)
  expect(said.some(one => one.includes('Question for you'))).toBe(false)
})

test('28. a command in the reply gets a Copy chip that puts it on your clipboard', async ($, on) => {
  const { clock } = boot(on, { voice: false, gist: 'Done: here is the command.' })
  const copied: string[] = []
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'how do I start it' })
  const answer = long('Run this:\n\n```bash\nnpm run dev\n```')
  await $.session.append(says(answer))
  await $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(String((await band.find({ key: 'copybutton0' }))?.props.label).trim()).toBe('Copy')
  expect((await band.find({ type: 'Text', text: /npm run dev/ }))).toBeDefined()
  await band.press({ key: 'copybutton0' })
  expect(copied).toEqual(['npm run dev'])
  expect(String((await band.find({ key: 'copybutton0' }))?.props.label).trim()).toBe('✓ Copied')
  await band.unmount()
})

test('29. a file opened on the right is named out loud and on the card', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true, gist: 'Done: the preview is up.\nSay: The yellow heli preview is ready.' })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'show me the heli' })
  await $.tool.call({ tool: 'SendUserFile', files: ['/x/yellow-heli.png'], status: 'normal' })
  await $.session.append(says('Here it is.'))
  await $.turn.complete({ answer: long('Here it is.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  expect(said.some(one => one.includes('I opened yellow heli on the right.'))).toBe(true)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'yellow-heli.png' }))?.text).toBe('yellow-heli.png')
  expect(String((await band.find({ key: 'openbutton0' }))?.props.label).trim()).toBe('Open')
  await band.press({ key: 'openbutton0' })
  expect(runs.some(argv => argv[0] === 'open' && argv[1] === '/x/yellow-heli.png')).toBe(true)
  await band.unmount()
})

test('30. a permission prompt: NEEDS YOU, said out loud, gone once the call goes on', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'clean up' })
  const decided = $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Delete the old build' } })
  await clock.advance(10_000)

  let band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'NEEDS YOU' }))?.text).toBe('NEEDS YOU')
  expect((await band.find({ type: 'Text', text: /I need your OK/ }))?.text).toBe(
    'I need your OK to go on: delete the old build.',
  )
  await band.unmount()
  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  expect(said.some(one => one.includes('Needs your attention. I need your OK'))).toBe(true)

  const answering = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await answering.press({ key: 'ask0' })
  await answering.unmount()
  await clock.advance(500)
  expect((await decided).decision?.behavior).toBe('allow')
  await $.tool.call({ tool: 'Bash', command: 'rm -rf build', description: 'Delete the old build' })
  band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: 'NEEDS YOU' })).toBeUndefined()
  await band.unmount()
})

test('31. a turn that dies on an error says so out loud, tagged NEEDS YOU', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'do the thing' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't', reason: 'error' })
  await clock.advance(30_000)

  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  expect(said.some(one => one.includes('Something went wrong and I stopped.'))).toBe(true)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'NEEDS YOU' }))?.text).toBe('NEEDS YOU')
  await band.unmount()
})

test('32. plan approval: NEEDS YOU with the plan in one line, Approve goes through', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'plan the heli race' })
  const decided = $.classic.PermissionRequest({ tool_name: 'ExitPlanMode', tool_input: { plan: '# Add a race course around the plaza\n\nDetails…' } })
  await clock.advance(10_000)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'NEEDS YOU' }))?.text).toBe('NEEDS YOU')
  expect((await band.find({ type: 'Text', text: /race course/ }))?.text).toBe(
    'The plan is ready: Add a race course around the plaza. Approve it?',
  )
  expect(String((await band.find({ key: 'ask0' }))?.props.label).trim()).toBe('Approve')
  expect(String((await band.find({ key: 'ask1' }))?.props.label).trim()).toBe('Keep planning')
  await band.press({ key: 'ask0' })
  await band.unmount()
  await clock.advance(500)
  expect((await decided).decision).toEqual({ behavior: 'allow' })
})

test('33. several questions, one at a time; multiple choice sends itself after your last click', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'make a heli' })
  const questions = [
    { question: 'Which helicopter?', header: 'Heli', multiSelect: false, options: [{ label: 'Civil' }, { label: 'Police' }] },
    { question: 'Which extras?', header: 'Extras', multiSelect: true, options: [{ label: 'Minigun' }, { label: 'Lights' }, { label: 'Siren' }] },
  ]
  const decided = $.classic.PermissionRequest({ tool_name: 'AskUserQuestion', tool_input: { questions } })
  await clock.advance(10_000)

  let band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'Which helicopter?' }))?.text).toBe('Which helicopter?')
  await band.press({ key: 'ask1' })
  await band.unmount()
  await clock.advance(10_000)

  band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'Which extras?' }))?.text).toBe('Which extras?')
  await band.press({ key: 'ask0' })
  await band.press({ key: 'ask2' })
  expect(String((await band.find({ key: 'ask2' }))?.props.label).trim()).toBe('✓ Siren')
  expect(await band.find({ key: 'asksend' })).toBeUndefined()
  await band.unmount()
  await clock.advance(2_000)
  const decision = (await decided).decision as { behavior: string; updatedInput: { answers: Record<string, string> } }
  expect(decision.behavior).toBe('allow')
  expect(decision.updatedInput.answers).toEqual({ 'Which helicopter?': 'Police', 'Which extras?': 'Minigun, Siren' })
})

test('34. helpers: "1 sub-agent running" with its name, ticked off when done; its later result is said', async ($, on) => {
  const { clock, runs, agents } = boot(on, { voice: true, gist: 'Done: the helper found three files.\nSay: The helper found three files.' })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'look around' })
  agents.push({ id: 'a1', description: 'Scan the assets', type: 'Explore', status: 'running' })
  await $.tool.call({ tool: 'Agent', description: 'Scan the assets', prompt: 'scan', run_in_background: true })
  await clock.advance(3_000)

  let band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: '1 sub-agent running' }))?.text).toBe('1 sub-agent running')
  expect((await band.find({ type: 'Text', text: 'Scan the assets' }))?.text).toBe('Scan the assets')
  await band.unmount()

  agents[0]!.status = 'completed'
  await clock.advance(3_000)
  band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: '1 sub-agent running' })).toBeUndefined()
  await band.unmount()

  // The result arrives in a later turn of its own: said like any reply.
  await $.session.append(says('The helper found three files.'))
  await $.turn.complete({ answer: long('The helper found three files.'), durationMs: 5, isAborted: false, turnId: 't2' })
  await clock.advance(30_000)
  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  expect(said.some(one => one.includes('The helper found three files.'))).toBe(true)
})

test('35. two chats: while the other one speaks, this one waits its turn', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true, lockedMs: 5_000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hi' })
  await $.session.append(says('Hello there.'))
  await clock.advance(3_000)
  expect(runs.some(argv => argv[0] === 'say')).toBe(false)
  await clock.advance(10_000)
  expect(runs.some(argv => argv[0] === 'say')).toBe(true)
})

test('37. permission prompt: Allow and Deny in the panel; Deny refuses the call', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'clean up' })
  const decided = $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build', description: 'Delete the old build' } })
  await clock.advance(10_000)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(String((await band.find({ key: 'ask0' }))?.props.label).trim()).toBe('Allow')
  expect(String((await band.find({ key: 'ask1' }))?.props.label).trim()).toBe('Deny')
  await band.press({ key: 'ask1' })
  await band.unmount()
  await clock.advance(500)
  expect((await decided).decision?.behavior).toBe('deny')
})

test('38. an error: one red line saying why, and Retry sends your message again', async ($, on) => {
  const { clock, prompts } = boot(on, { voice: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'do the thing' })
  await $.classic.StopFailure({ error: 'rate_limit' } as never)
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't', reason: 'error' })
  await clock.advance(30_000)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const red = await band.find({ type: 'Text', text: 'Hit the usage limit.' })
  expect(red?.props.color).toBe('#E5484D')
  await band.press({ key: 'retry' })
  await band.unmount()
  expect(prompts.filter(one => one === 'do the thing')).toHaveLength(2)
})

test('39. out of OpenAI credit: a small "voice off" note', async ($, on) => {
  const { clock } = boot(on, { voice: true, key: true, streamError: 'OpenAI: You exceeded your current quota (insufficient_quota)' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hi' })
  await $.session.append(says('Hello there.'))
  await clock.advance(3_000)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'voice off · out of OpenAI credit' }))?.text).toBe(
    'voice off · out of OpenAI credit',
  )
  await band.unmount()
})

test('40. a chat stops only its own voice, and a cut line is never stopped by the panel moving on', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true, key: true, live: true, heard: [{ word: 'Hello', start: 0 }] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hi' })
  await $.session.append(says('Hello there.'))
  await clock.advance(1_000)
  await $.prompt.submit({ text: 'next' })
  await clock.advance(1_000)

  const stops = runs.filter(argv => argv[0] === 'pkill')
  expect(stops.length).toBeGreaterThan(0)
  for (const stop of stops) {
    expect(stop[1]).toBe('-USR2')
    expect(stop[3]).toMatch(/^realtime-stream\.mjs \.\*chat-/)
  }
  const helper = runs.find(argv => argv[0] !== 'pgrep' && argv.some(arg => arg.endsWith('realtime-stream.mjs')))
  expect(helper?.[6]).toMatch(/^chat-/)
})

test('41. a helper\'s result continues the same reply: your message stays, the helper is ticked off', async ($, on) => {
  const { clock, agents } = boot(on, { voice: false })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'look around' })
  agents.push({ id: 'a1', description: 'Scan the assets', type: 'Explore', status: 'running' })
  await $.tool.call({ tool: 'Agent', description: 'Scan the assets', prompt: 'scan', run_in_background: true })
  await $.session.append(says('Started a helper.'))
  await $.turn.complete({ answer: 'Started a helper.', durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(10_000)

  await $.prompt.submit({
    text: '<task-notification>\n<task-id>a1</task-id>\n<summary>Agent "Scan the assets" finished</summary>\n</task-notification>',
    origin: { kind: 'task-notification' },
  } as never)
  await clock.advance(1_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'look around' }))?.text).toBe('look around')
  expect(await band.find({ type: 'Text', text: /task-notification/ })).toBeUndefined()
  await band.unmount()
})

test('42. a click that reaches Claude late is dropped, never sent after you moved on', async ($, on) => {
  const { clock, prompts } = boot(on, { voice: false, gist: 'Question: Ready?\n> Yes\n> No' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'ask me' })
  await $.session.append(says(long('Ready?')))
  await $.turn.complete({ answer: long('Ready?'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)
  // You type something else; then the app delivers an old click of the panel's.
  await $.prompt.submit({ text: 'something else' })
  const late = await $.prompt.submit({ text: 'Yes', origin: { kind: 'plugin', name: 'bob-mod-claude' } } as never)
  expect('drop' in late && late.drop).toBeTruthy()
  expect(prompts).not.toContain('Yes')
})

test('43. your message switches the panel to thinking before the app has taken it', async ($, on) => {
  const { clock } = boot(on, { voice: false, promptDelayMs: 10_000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const sending = $.prompt.submit({ text: 'make it gold' })
  await clock.advance(1_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'make it gold' }))?.text).toBe('make it gold')
  expect((await band.find({ type: 'Text', text: /^(Thinking|Cooking)$/ }))).toBeDefined()
  await band.unmount()
  await clock.advance(10_000)
  await sending
})

test('44. plan buttons show while the line is still said, and go once the app answers', async ($, on) => {
  const { clock } = boot(on, { voice: true })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'plan it' })
  const decided = $.classic.PermissionRequest({ tool_name: 'ExitPlanMode', tool_input: { plan: '# Add a race course' } })
  await clock.advance(300)
  let band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(String((await band.find({ key: 'ask0' }))?.props.label).trim()).toBe('Approve')
  await band.unmount()

  // The app's own dialog answered: the call goes on, the buttons go.
  await $.tool.call({ tool: 'ExitPlanMode' } as never)
  await clock.advance(500)
  expect((await decided).decision).toBeUndefined()
  band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ key: 'ask0' })).toBeUndefined()
  await band.unmount()
})

test('45. Retry after a stop: your message goes straight in the box, never stuck on Cooking', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  const filled: string[] = []
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'stop test' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't', reason: 'aborted' })
  await clock.advance(5_000)

  let band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'Stopped.' }))?.text).toBe('Stopped.')
  await band.press({ key: 'retry' })
  await band.unmount()
  await clock.advance(500)

  expect(filled).toEqual(['stop test'])
  band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /Press Enter to retry/ }))?.text).toBe('Stopped. Press Enter to retry.')
  expect(await band.find({ type: 'Text', text: /^(Thinking|Cooking)$/ })).toBeUndefined()
  await band.unmount()
})

test('46. out of the box the free Mac voice speaks, even with an OpenAI key', async ($, on) => {
  const { clock, runs, fetches } = boot(on, { voice: true, key: true, live: true, engine: null, gist: 'Done: all set.\nSay: Hello there, Claude speaking.' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hello' })
  await $.session.append(says('Working on it.'))
  await $.turn.complete({ answer: long('Working on it.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(20_000)

  expect(fetches).toHaveLength(0)
  expect(runs.some(argv => argv.some(arg => arg.endsWith('realtime-stream.mjs') || arg.endsWith('realtime-voice.mjs')))).toBe(false)
  expect(runs.some(argv => argv[0] === 'say')).toBe(true)
})

test('47. /bob normal speaks with OpenAI text-to-speech, /bob live with the live voice, /bob mac back to free', async ($, on) => {
  const { clock, runs, fetches } = boot(on, { voice: true, key: true, live: true, engine: null, gist: 'Done: all set.\nSay: Hello there, Claude speaking.' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(JSON.stringify(await $.command.run({ command: 'bob', args: 'normal' }))).toContain("OpenAI's normal voice")
  await $.prompt.submit({ text: 'hello' })
  await $.session.append(says('Working on it.'))
  await $.turn.complete({ answer: long('Working on it.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(20_000)
  expect(fetches.some(one => one.startsWith('https://api.openai.com/v1/audio/speech'))).toBe(true)
  expect(runs.some(argv => argv.some(arg => arg.endsWith('realtime-stream.mjs')))).toBe(false)

  expect(JSON.stringify(await $.command.run({ command: 'bob', args: 'live' }))).toContain("OpenAI's live voice")
  expect(JSON.stringify(await $.command.run({ command: 'bob', args: '' }))).toContain("OpenAI's live voice")
  expect(JSON.stringify(await $.command.run({ command: 'bob', args: 'mac' }))).toContain("the Mac's own voice (free)")
  expect(JSON.stringify(await $.command.run({ command: 'bob', args: '' }))).toContain("the Mac's own voice (free)")
})
