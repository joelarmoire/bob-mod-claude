import { expect, mock, test } from 'claude-code/testing'

// Longer than a short reply, so the summary step runs (a short one is said as is).
const long = (text: string) => `${text} ${'There is more detail in the full reply here. '.repeat(4)}`
import type { On } from 'claude-code'

const BAND = {
  plugin: 'bob-talks-back',
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

// The side panel on the right, where Full reply opens.
const PANE_SITE = {
  plugin: 'bob-talks-back',
  component: 'Pane',
  requestId: 'bob',
  props: { title: 'Full reply', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
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
  // The summary model gives no line (it timed out).
  gistFails?: boolean
  // What the history file already holds from earlier chats.
  history?: string
  // How long the Mac voice takes to say a line, as on a real Mac.
  sayMs?: number
  sayWrap?: number
  // Talking to Claude through the orb: what OpenAI writes out, and how loud the mic was (dB, at its loudest).
  heardYou?: string
  micLevel?: number
  // The voice picked with /bob mac, normal or live; most tests run on the live one, null leaves it unpicked.
  engine?: 'mac' | 'normal' | 'live' | null
  // whisper.cpp and its English model are on this Mac.
  whisper?: boolean
  // The surfaces the session draws on, asked at each call: the desktop app's by default; none in a -p run.
  surfaces?: () => string[]
}

// A session with Bob loaded and everything beneath him stood in for: what he
// plays, runs and fetches is recorded.
function boot(
  on: On,
  { voice, key = false, gist = 'Done: all set.', refuses, live = false, stuck = false, heard, streamError, lockedMs = 0, promptDelayMs = 0, gistFails = false, history = '', sayMs = 0, sayWrap = Infinity, heardYou = 'Make the button purple.', micLevel = -18, engine = 'live', whisper = false, surfaces = () => ['desktop'] }: Boot,
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
  on('session.surfaces', () => ({ value: surfaces() as never }))
  // The Mac's mics as ffmpeg lists them: a loopback, an app mic, then earbuds.
  const MICS = '[AVFoundation indev @ 0x1] AVFoundation audio devices:\n[AVFoundation indev @ 0x1] [0] Camo Microphone\n[AVFoundation indev @ 0x1] [1] Baseus Bass BP1 Pro\n[AVFoundation indev @ 0x1] [2] BlackHole 16ch\n'
  // ffmpeg records until the mod sends it pkill -INT.
  let isMicStopped = false
  on('fs.exists', (_, e) => {
    const path = String(e.path)
    const isWhisper = whisper && (path === '/opt/homebrew/bin/whisper-cli' || path === '/.config/bob/ggml-base.en.bin')
    return { value: path === '/opt/homebrew/bin/ffmpeg' || isWhisper }
  })
  on('command.register', () => ({ value: { command: 'bob' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.write', (_, e) => {
    written.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) =>
    key && String(e.path).endsWith('openai.env')
      ? { value: 'OPENAI_API_KEY=sk-test-0000000000000000000000' }
      : String(e.path).endsWith('-history.log')
        ? { value: history }
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
    if (e.argv[0] === 'say' && sayMs > 0) await clock.sleep(sayMs)
    if (e.argv[0] === '/opt/homebrew/bin/whisper-cli') return { value: { exitCode: 0, stdout: ` ${heardYou}\n`, stderr: '' } }
    if (e.argv.includes('-list_devices')) return { value: { exitCode: 1, stdout: '', stderr: MICS } }
    if (e.argv.includes('volumedetect')) return { value: { exitCode: 0, stdout: '', stderr: `[Parsed_volumedetect_0] max_volume: ${micLevel} dB\n` } }
    if (e.argv[0] === '/usr/bin/pkill' && e.argv[1] === '-INT') isMicStopped = true
    if (e.argv[0] === '/usr/bin/curl' && e.argv.some(arg => String(arg).endsWith('/audio/transcriptions'))) {
      return { value: { exitCode: 0, stdout: JSON.stringify({ text: heardYou }), stderr: '' } }
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
    // The Mac voice through `script` and `say -i`: recorded as the say it is, and each word marked as it is said.
    const sayAt = e.argv.findIndex(arg => String(arg).includes('/usr/bin/say'))
    if (sayAt >= 0) {
      runs.push(['say', ...e.argv.slice(sayAt), JSON.stringify(e)])
      const text = String(e.argv.at(-1) ?? '')
      const words = text.split(' ')
      // A wrapped line (sayWrap words fit the screen): say redraws only the screen line it is on, so its marks count
      // from that line's start.
      const wrapAt = sayWrap
      for (let at = 0; at < words.length; at++) {
        if (sayMs > 0) await clock.sleep(sayMs / words.length)
        const lineStart = at < wrapAt ? 0 : wrapAt
        yield { stream: 'stdout' as const, text: `\r\x1b[M${words.slice(lineStart, at).join(' ')}${at > lineStart ? ' ' : ''}\x1b[7m${words[at]}\x1b(B\x1b[m ${words.slice(at + 1).join(' ')}` }
      }
      yield { stream: 'stdout' as const, text: '\r\x1b[M' }
      return { value: { code: 0, signal: null } }
    }
    runs.push([...e.argv, JSON.stringify(e)])
    // ffmpeg recording the mic: it opens, then records until it is told to stop.
    if (e.argv.includes('avfoundation')) {
      yield { stream: 'stderr' as const, text: "Output #0, wav, to '/private/tmp/bob-voice/mic.wav':\n" }
      while (!isMicStopped) await clock.sleep(1000)
      isMicStopped = false
      return { value: { code: 0, signal: null } }
    }
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
  const summaries: string[] = []
  on('model.complete', (_, e) => (summaries.push(String(e.prompt)), gistFails ? { value: { isAnswered: false as const, reason: 'aborted' as const } } : {
    value: {
      isAnswered: true as const,
      text: gist,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  return { clock, sounds, runs, fetches, prompts, agents, written, summaries }
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
  expect(runs.find(argv => argv[0] === 'say')).toContain('Daniel')
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

test('7. 🔊 then Mute all mutes every sound and stops the voice', async ($, on) => {
  const { clock, sounds, runs } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'voice' })
  await band.press({ key: 'mute-all' })
  expect((await band.find({ key: 'voice' }))?.props.label).toBe('🔇')
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
    plugin: 'bob-talks-back',
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
    e.plugin === 'bob-talks-back' && e.key === 'reply' ? { value: { value: older, version: 1 } } : next(e),
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
  expect(helper?.[3]).toBe('echo') // [env, node, helper, voice, …]
})

test('19. the live voice runs with the picked voice, model and style', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true, key: true, live: true, gist: 'Done: all set.\nSay: Hello there, Claude speaking.' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hello' })
  await $.session.append(says('Working on it.'))
  await $.turn.complete({ answer: long('Working on it.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(6000)

  const helper = runs.find(argv => argv[0] !== 'pgrep' && argv.some(arg => arg.endsWith('realtime-stream.mjs')))
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
  const late = await $.prompt.submit({ text: 'Yes', origin: { kind: 'plugin', name: 'bob-talks-back' } } as never)
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

test('49. a short reply never says its first sentence twice', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'which format for X?' })
  const reply = 'No, put the normal one on X. The vertical ones are for TikTok and Shorts.'
  await $.session.append(says(reply))
  // The headline is read out as the reply arrives, before the turn ends.
  await clock.advance(6000)
  await $.turn.complete({ answer: reply, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  expect(said.filter(one => one.includes('No, put the normal one on X.'))).toHaveLength(1)
  expect(said.some(one => one.includes('The vertical ones are for TikTok and Shorts.'))).toBe(true)
})

test('50. when the summary never comes, the end of the reply is said, not just its opening', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true, gistFails: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'will it go viral?' })
  const reply =
    'You are probably right, five hundred views is not viral yet. It is still good for your account. ' +
    'Nobody joined because the video gives them nowhere to go. Reply under the stunt with the link before tonight.'
  await $.session.append(says(reply))
  await clock.advance(6000)
  await $.turn.complete({ answer: reply, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  expect(said.some(one => one.includes('Reply under the stunt with the link before tonight.'))).toBe(true)
})

test('51. a long opening is cut to its first part as it arrives', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'build it' })
  await $.session.append(
    says(
      "I'm building it in its original colors, 35 parts and about 9,800 triangles, and once the body is done the door minigun goes on.",
    ),
  )
  await clock.advance(8000)
  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  expect(said.some(one => one.includes("I'm building it in its original colors, 35 parts and about 9,800 triangles."))).toBe(true)
  expect(said.some(one => one.includes('door minigun'))).toBe(false)
})

test('52. a long reply\'s card says there is more in the full reply; a short one does not', async ($, on) => {
  const { clock } = boot(on, { voice: false, gist: 'Update: The plan is set.' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'what is the plan' })
  const reply = Array.from({ length: 12 }, (_, at) => `Point ${at + 1} of the plan has a few words in it.`).join(' ')
  await $.session.append(says(reply))
  await $.turn.complete({ answer: reply, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(String((await band.find({ key: 'fullbutton' }))?.props.label).trim()).toBe('Full reply')
  await band.unmount()

  await $.prompt.submit({ text: 'and now' })
  await $.session.append(says('All set, nothing else to do.'))
  await $.turn.complete({ answer: 'All set, nothing else to do.', durationMs: 5, isAborted: false, turnId: 't2' })
  await clock.advance(30_000)
  const again = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await again.find({ key: 'fullbutton' })).toBeUndefined()
  await again.unmount()
})

test('53. what was said goes to a history file that a reload keeps adding to', async ($, on) => {
  const { clock, written } = boot(on, { voice: true, history: '2026-10-24 20:00:00 say #0 (system): an older line' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hello' })
  await $.session.append(says('Working on it.'))
  await $.turn.complete({ answer: long('Working on it.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(20_000)
  const file = [...written.entries()].find(([path]) => path.endsWith('-history.log'))?.[1] ?? ''
  expect(file).toContain('an older line')
  expect(file).toContain('say #')
})

const NOTE = '\n\n[bob-tag]: # "Done: The helicopter is yellow now"\n[bob-say]: # "It is painted Dot World yellow, ready to upload when you are."'

test('54. Claude\'s own note gives the spoken line: no summary model, and the note is never read or shown', async ($, on) => {
  const { clock, runs, summaries } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'paint it' })
  const reply = long('Painted the three body panels in the game color and kept the trim, glass and lights as they were.') + NOTE
  await $.session.append(says(reply))
  await clock.advance(6000)
  await $.turn.complete({ answer: reply, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  expect(summaries).toHaveLength(0)
  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  expect(said.some(one => one.includes('It is painted Dot World yellow, ready to upload when you are.'))).toBe(true)
  expect(said.some(one => one.includes('bob-say') || one.includes('Say:'))).toBe(false)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'The helicopter is yellow now' }))?.text).toBe('The helicopter is yellow now')
  expect(await band.find({ type: 'Text', text: /bob-say|Say:/ })).toBeUndefined()
  await band.unmount()
})

test('55. a question in Claude\'s note becomes buttons', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'colors?' })
  const reply = long('The helicopter is built and the minigun is on.') + '\n\n[bob-tag]: # "Question: Which color?"\n[bob-say]: # "The build is done."\n[bob-option-1]: # "Dot World yellow"\n[bob-option-2]: # "Original"'
  await $.session.append(says(reply))
  await $.turn.complete({ answer: reply, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.findAll({ type: 'Button' })).map(one => String(one.props.label).trim())).toEqual(
    expect.arrayContaining(['Dot World yellow', 'Original']),
  )
  await band.unmount()
})

test('56. without a note the summary model still writes the line', async ($, on) => {
  const { clock, summaries } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hello' })
  await $.session.append(says('Working on it.'))
  await $.turn.complete({ answer: long('Working on it.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(20_000)
  expect(summaries).toHaveLength(1)
})

test('57. the instructions ask Claude for the note, in the desktop app and in a terminal', async ($, on) => {
  boot(on, { voice: true })
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const tools of [['mcp__ccd_turn__wrap_up'], []]) {
    const out = (await $.prompt.compose({ model: 'test', promptModel: 'test', surfaces: ['desktop'], tools, outputStyle: null, traits: [], sections: [] } as never)) as { sections: { id: string; text: string }[] }
    expect(out.sections.find(one => one.id.endsWith(':spoken-line'))?.text).toContain('mcp__bob-talks-back__panel')
  }
})

test('58. something to copy gets a Copy button under the orb, named by Claude; its text is in Full reply', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  const copied: string[] = []
  on('ui.copy', (_, e) => {
    copied.push(e.text)
    return { value: { isCopied: true as const } }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'write the tweet' })
  const answer = long('Here it is:\n\n```text\nClaude talks back now.\nTry it.\n```') +
    '\n\n[bob-tag]: # "Done: The tweet is ready"\n[bob-say]: # "The tweet is ready to copy in the panel."\n[bob-copy-1]: # "Tweet reply"'
  await $.session.append(says(answer))
  await $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: /^“Claude talks back now\./ }))?.text).toMatch(/^“Claude talks back now\./)
  expect(await band.find({ type: 'Text', text: /Try it\./ })).toBeUndefined()
  await band.press({ key: 'copybutton0' })
  expect(copied).toEqual(['Claude talks back now.\nTry it.'])
  await band.unmount()
})

test('59. files and web pages the reply points to get Open buttons', async ($, on) => {
  const { clock, runs } = boot(on, { voice: false, gist: 'Done: Both are ready.' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'where are they' })
  const answer = long('The video is [the demo](/Users/you/Desktop/demo.mp4) and the code is on https://github.com/joelarmoire/bob-mod-claude.')
  await $.session.append(says(answer))
  await $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'the demo' }))?.text).toBe('the demo')
  expect((await band.find({ type: 'Text', text: 'github.com/joelarmoire/bob-mod-claude' }))?.text).toBe('github.com/joelarmoire/bob-mod-claude')
  await band.press({ key: 'linkbutton0' })
  await clock.advance(1000)
  expect(runs.some(argv => argv[0] === 'open' && argv[1] === '/Users/you/Desktop/demo.mp4')).toBe(true)
  await band.unmount()
})

test('60. Full reply opens the whole reply in the panel', async ($, on) => {
  const { clock } = boot(on, { voice: false, gist: 'Update: The plan is set.' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'what is the plan' })
  const reply = Array.from({ length: 12 }, (_, at) => `Point ${at + 1} of the plan has a few words in it.`).join('\n\n')
  await $.session.append(says(reply))
  await $.turn.complete({ answer: reply, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ type: 'Text', text: 'Point 7 of the plan has a few words in it.' })).toBeUndefined()
  await band.press({ key: 'fullbutton' })
  // It opens in the side panel on the right; the band stays as it was, its button now Hide full reply.
  expect(await band.find({ type: 'Markdown' })).toBeUndefined()
  expect(String((await band.find({ key: 'fullbutton' }))?.props.label).trim()).toBe('Hide full reply')
  const pane = await $.ui.mount({ ...PANE_SITE, surface: 'desktop' })
  expect(String((await pane.find({ type: 'Markdown' }))?.props.text)).toContain('Point 7 of the plan has a few words in it.')
  await pane.unmount()
  await band.unmount()
})

test('61. the one-line note: the main line, its points on the card, a named copy card and options', async ($, on) => {
  const { clock, summaries } = boot(on, { voice: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'what now' })
  const answer = long('Here is the tweet:\n\n```text\nClaude talks back now.\n```') +
    '\n\n[bob]: # "Question: Post it tonight? | Say: The tweet is ready to copy in the panel. | Point: A testing plan before we publish | Copy: Tweet reply | Option: Tonight | Option: Tomorrow"'
  await $.session.append(says(answer))
  await $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  expect(summaries).toHaveLength(0)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'Post it tonight?' }))?.text).toBe('Post it tonight?')
  expect((await band.find({ type: 'Text', text: '• A testing plan before we publish' }))?.text).toBe('• A testing plan before we publish')
  expect((await band.find({ type: 'Text', text: /^“Claude talks back now\./ }))?.text).toMatch(/^“Claude talks back now\./)
  expect((await band.findAll({ type: 'Button' })).map(one => String(one.props.label).trim())).toEqual(expect.arrayContaining(['Tonight', 'Tomorrow']))
  expect(await band.find({ type: 'Text', text: /\[bob\]/ })).toBeUndefined()
  await band.unmount()
})

// Every case, panel only: what you would miss if the card did not show it.
const finish = async ($: Parameters<Parameters<typeof test>[1]>[0], clock: { advance: (ms: number) => Promise<void> }, answer: string, turnId = 't') => {
  await $.session.append(says(answer))
  await $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId })
  await clock.advance(30_000)
}

test('62. case: two texts to copy get two named cards, each with its own Show and Copy', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  const copied: string[] = []
  on('ui.copy', (_, e) => (copied.push(e.text), { value: { isCopied: true as const } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'write both tweets' })
  await finish($, clock, long('Main tweet:\n\n```text\nFirst tweet.\n```\n\nReply:\n\n```text\nSecond tweet.\n```') +
    '\n\n[bob]: # "Done: Both tweets are ready | Say: Both tweets are ready to copy in the panel. | Copy: Main tweet | Copy: Reply"')
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // What each button copies, shown as its own first words.
  expect((await band.find({ type: 'Text', text: '“First tweet.”' }))?.text).toBe('“First tweet.”')
  expect((await band.find({ type: 'Text', text: '“Second tweet.”' }))?.text).toBe('“Second tweet.”')
  await band.press({ key: 'copybutton1' })
  await band.press({ key: 'copybutton0' })
  expect(copied).toEqual(['Second tweet.', 'First tweet.'])
  await band.unmount()
})

test('63. case: a choice between two plans shows both as buttons, with what each one is, and a click answers', async ($, on) => {
  const { clock, prompts } = boot(on, { voice: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'how should we launch' })
  await finish($, clock, long('Plan A: post tonight. Plan B: wait for Monday.') +
    '\n\n[bob]: # "Question: Plan A or plan B? | Say: Two ways to launch. | Point: Plan A posts tonight | Point: Plan B waits for Monday | Option: Plan A | Option: Plan B"')
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: '• Plan A posts tonight' }))?.text).toBe('• Plan A posts tonight')
  expect((await band.find({ type: 'Text', text: '• Plan B waits for Monday' }))?.text).toBe('• Plan B waits for Monday')
  await band.press({ key: 'choice1' })
  expect(prompts.at(-1)).toBe('Plan B')
  await band.unmount()
})

test('64. case: a file sent and also linked in the text gets one Open button, not two', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'send me the video' })
  await $.tool.call({ tool: 'SendUserFile', files: ['/Users/you/Desktop/demo.mp4'], status: 'normal' })
  await finish($, clock, long('Sent: [demo.mp4](/Users/you/Desktop/demo.mp4).') + '\n\n[bob]: # "Done: The video is ready | Say: I sent you the video, open it from the panel."')
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const opens = (await band.findAll({ type: 'Button' })).filter(one => String(one.props.label).trim() === 'Open')
  expect(opens).toHaveLength(1)
  await band.unmount()
})

test('65. case: a project file linked the usual way and a full path written as code both get Open buttons', async ($, on) => {
  const { clock, runs } = boot(on, { voice: false })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'where is it' })
  await finish($, clock, long('The brief is [brief.md](work/brief.md:12) and the video is `~/Desktop/demo video.mp4`.') +
    '\n\n[bob]: # "Done: Both files are linked | Say: The brief and the video can be opened from the panel."')
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'demo video.mp4' }))?.text).toBe('demo video.mp4')
  expect((await band.find({ type: 'Text', text: 'brief.md' }))?.text).toBe('brief.md')
  await band.press({ key: 'linkbutton1' })
  await band.press({ key: 'linkbutton0' })
  await clock.advance(1000)
  expect(runs.some(argv => argv[0] === 'open' && argv[1] === '/proj/work/brief.md')).toBe(true)
  expect(runs.some(argv => argv[0] === 'open' && String(argv[1]).endsWith('/Desktop/demo video.mp4'))).toBe(true)
  await band.unmount()
})

test('66. case: the full reply in the panel never shows the hidden note', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'explain' })
  const body = Array.from({ length: 10 }, (_, at) => `Part ${at + 1} explains one more thing about it.`).join('\n\n')
  await finish($, clock, `${body}\n\n[bob]: # "Update: Ten parts explained | Say: I explained it in ten parts. | Point: The last part matters most"`)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'fullbutton' })
  const pane = await $.ui.mount({ ...PANE_SITE, surface: 'desktop' })
  const full = String((await pane.find({ type: 'Markdown' }))?.props.text)
  expect(full).toContain('Part 10 explains one more thing about it.')
  expect(full).not.toMatch(/\[bob|Say:/)
  await pane.unmount()
  await band.unmount()
})

test('67. case: everything at once: question, points, a copy card, a sent file, a link, all on the card', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'get it all ready' })
  await $.tool.call({ tool: 'SendUserFile', files: ['/x/clip.mp4'], status: 'normal' })
  await finish($, clock, long('Copy this:\n\n```text\nthe caption\n```\n\nCode: https://github.com/a/b') +
    '\n\n[bob]: # "Question: Post now? | Say: The clip and caption are ready, and the repo link is in the panel. | Point: The repo is still private | Copy: Caption | Option: Post now | Option: Wait"')
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  for (const text of ['Post now?', '• The repo is still private', '“the caption”', 'clip.mp4', 'github.com/a/b']) {
    expect((await band.find({ type: 'Text', text }))?.text).toBe(text)
  }
  expect((await band.findAll({ type: 'Button' })).map(one => String(one.props.label).trim())).toEqual(
    expect.arrayContaining(['Post now', 'Wait', 'Copy', 'Open']),
  )
  await band.unmount()
})

test('68. the two-line note carries points, copy names and options in its say line', async ($, on) => {
  const { clock, summaries } = boot(on, { voice: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'what now' })
  const answer = long('Here is the tweet:\n\n```text\nClaude talks back now.\n```') +
    '\n\n[bob-tag]: # "Question: Post it tonight?"\n[bob-say]: # "The tweet is ready to copy in the panel. | Point: A testing plan before we publish | Copy: Tweet reply | Option: Tonight | Option: Tomorrow"'
  await $.session.append(says(answer))
  await $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  expect(summaries).toHaveLength(0)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  for (const text of ['Post it tonight?', 'The tweet is ready to copy in the panel.', '• A testing plan before we publish', '“Claude talks back now.”']) {
    expect((await band.find({ type: 'Text', text }))?.text).toBe(text)
  }
  expect((await band.findAll({ type: 'Button' })).map(one => String(one.props.label).trim())).toEqual(expect.arrayContaining(['Tonight', 'Tomorrow']))
  expect(await band.find({ type: 'Text', text: /\[bob|\| Point/ })).toBeUndefined()
  await band.unmount()
})

test('69. when the reply ends mid-sentence, the sentence being read finishes in one go, never cut and restarted', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true, sayMs: 4000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'is it done' })
  const answer = long('Done in your copy, and all 68 tests pass.') + '\n\n[bob-tag]: # "Done: All tests pass"\n[bob-say]: # "Everything passes and nothing else changed."'
  await $.session.append(says(answer))
  for (const ms of [300, 700, 1200, 2000]) {
    await clock.advance(ms)
  }
  await $.turn.complete({ answer, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  expect(said.filter(one => one.includes('and all 68 tests pass.'))).toHaveLength(1)
  expect(said.some(one => one.includes('Done in your copy, and all 68 tests pass.'))).toBe(true)
  expect(said.some(one => one.includes('Everything passes and nothing else changed.'))).toBe(true)
})

test('70. the panel tool: Claude hands the line over through a tool, so nothing shows in the chat, and nobody is asked', async ($, on) => {
  const { clock, summaries } = boot(on, { voice: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'write the tweet' })
  await $.session.append(says(long('Here it is:\n\n```text\nClaude talks back now.\n```')))
  const check = await $.tool.check({ tool: 'mcp__bob-talks-back__panel', input: {} } as never)
  expect((check as { decision: string }).decision).toBe('allow')
  await $.tool.call({
    tool: 'mcp__bob-talks-back__panel',
    tag: 'Question: Post it tonight?',
    say: 'The tweet is ready to copy in the panel.',
    points: ['A testing plan before we publish'],
    copy: ['Tweet reply'],
    options: ['Tonight', 'Tomorrow'],
  } as never)
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  expect(summaries).toHaveLength(0)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  for (const text of ['Post it tonight?', 'The tweet is ready to copy in the panel.', '• A testing plan before we publish', '“Claude talks back now.”']) {
    expect((await band.find({ type: 'Text', text }))?.text).toBe(text)
  }
  expect((await band.findAll({ type: 'Button' })).map(one => String(one.props.label).trim())).toEqual(expect.arrayContaining(['Tonight', 'Tomorrow']))
  await band.unmount()
})

test('71. a must-read: the voice says to open the full reply, the button stands out with why, and the full reply is readable', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'how do I set it up' })
  await $.session.append(says('Here are the steps.\n\nStep one opens the file.\n\nStep two pastes the key.'))
  await $.tool.call({ tool: 'mcp__bob-talks-back__panel', tag: 'Done: Setup steps are ready', say: 'The setup takes two steps.', mustRead: 'the steps to follow' } as never)
  await $.turn.complete({ answer: 'Here are the steps.', durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)

  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  expect(said.some(one => one.includes('Open the full reply in the panel: the steps to follow.'))).toBe(true)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  // At the bottom right, in a thin orange frame: "! Must read" and the Full reply button; the reason is said out loud.
  expect((await band.find({ type: 'Text', text: '! Must read' }))?.text).toBe('! Must read')
  expect(String((await band.find({ key: 'fullbutton' }))?.props.label).trim()).toBe('Full reply')
  await band.press({ key: 'fullbutton' })
  const pane = await $.ui.mount({ ...PANE_SITE, surface: 'desktop' })
  const full = await pane.find({ type: 'Markdown' })
  expect(String(full?.props.text)).toContain('Step two pastes the key.')
  expect(full?.props.dimColor).toBeFalsy()
  await pane.unmount()
  await band.unmount()
})

test('72. an open full reply has Copy all, which copies the whole reply without the hidden note', async ($, on) => {
  const { clock } = boot(on, { voice: false, gist: 'Update: The plan is set.' })
  const copied: string[] = []
  on('ui.copy', (_, e) => (copied.push(e.text), { value: { isCopied: true as const } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'what is the plan' })
  const reply = Array.from({ length: 12 }, (_, at) => `Point ${at + 1} of the plan has a few words in it.`).join('\n\n') + '\n\n[bob-tag]: # "Update: The plan"'
  await $.session.append(says(reply))
  await $.turn.complete({ answer: reply, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ key: 'copyfull' })).toBeUndefined()
  await band.press({ key: 'fullbutton' })
  const pane = await $.ui.mount({ ...PANE_SITE, surface: 'desktop' })
  await pane.press({ key: 'copyfull' })
  expect(copied).toHaveLength(1)
  expect(copied[0]).toContain('Point 12 of the plan has a few words in it.')
  expect(copied[0]).not.toContain('[bob-tag]')
  expect(String((await pane.find({ key: 'copyfull' }))?.props.label).trim()).toBe('✓ Copied')
  await pane.unmount()
  await band.unmount()
})

test('73. the Mac voice lights each word the moment say marks it, not by a guess', async ($, on) => {
  // say takes 6 s for this line and marks each of its 8 words in turn: 750 ms apart, whatever the words look like.
  const { clock, runs } = boot(on, { voice: true, sayMs: 6000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'when' })
  await $.session.append(says('Two options: tonight, 20:00 to 22:00 your time.'))
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const litAt: Record<string, number> = {}
  for (let step = 0; step < 120; step++) {
    await clock.advance(100)
    const lit = (await band.findAll({ type: 'Box' })).find(one => one.props.backgroundColor !== undefined && one.key?.startsWith('w'))
    if (lit?.key && litAt[lit.key] === undefined) litAt[lit.key] = clock.now()
  }
  await band.unmount()
  expect(runs.some(argv => argv[0] === 'say' && String(argv[1]).includes(' -i '))).toBe(true)
  const gap = litAt.w2! - litAt.w1!
  expect(gap).toBeGreaterThanOrEqual(650)
  expect(gap).toBeLessThanOrEqual(850)
})

test('74. a Mac line stopped by your next message before its first word is cut, not said again the old way', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true, sayMs: 8000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'first' })
  await $.session.append(says('This first line gets interrupted right away.'))
  await clock.advance(50)
  await $.prompt.submit({ text: 'second' })
  await clock.advance(20_000)
  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  expect(said.filter(one => one.includes('This first line gets interrupted right away.')).length).toBeLessThanOrEqual(1)
})

test('75. a spoken line that ends on a question is not followed by "Question for you" and the question again', async ($, on) => {
  const { clock, sounds, runs } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'what next' })
  await $.session.append(says(long('Three things are waiting.')))
  await $.tool.call({
    tool: 'mcp__bob-talks-back__panel',
    tag: 'Question: Which one do you want first?',
    say: 'Three things are waiting on you: voice typing, the test round and two fixes. Which one should we tackle first?',
    options: ['Voice typing', 'Test round', 'Fixes'],
  } as never)
  await $.turn.complete({ answer: long('Three things are waiting.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(60_000)

  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  expect(said.some(one => one.includes('Question for you'))).toBe(false)
  expect(said.filter(one => one.includes('Which one')).length).toBe(1)
  expect(said.at(-1)).toContain('"Which one should we tackle first?"]')
  expect(sounds.some(one => one.includes('ask.wav'))).toBe(true)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'QUESTION FOR YOU' }))?.text).toBe('QUESTION FOR YOU')
  expect((await band.findAll({ type: 'Button' })).map(one => String(one.props.label).trim())).toEqual(expect.arrayContaining(['Voice typing', 'Test round', 'Fixes']))
  await band.unmount()
})

test('76. a spoken line that does not end on a question still gets "Question for you" and the question', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'tweet' })
  await $.session.append(says(long('The tweet is ready.')))
  await $.tool.call({ tool: 'mcp__bob-talks-back__panel', tag: 'Question: Post it tonight?', say: 'The tweet is ready to copy in the panel.' } as never)
  await $.turn.complete({ answer: long('The tweet is ready.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(60_000)

  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  expect(said.findIndex(one => one.includes('ready to copy'))).toBeLessThan(said.findIndex(one => one.includes('Question for you. Post it tonight?')))
})

test('77. a long opening is never cut before a "but" that turns it around', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'heartbeat' })
  await $.session.append(
    says(
      "Found it: the mod does play the heartbeat (the log shows it at 4 s), but the sound is almost all deep bass below 150 Hz, which your Mac mini's speaker can't play. Making a version you can hear on it.",
    ),
  )
  await clock.advance(10_000)
  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  expect(said.some(one => one.includes('Found it: the mod does play the heartbeat, but the sound is almost all deep bass below 150 Hz."'))).toBe(true)
  expect(said.some(one => one.includes('the log shows'))).toBe(false)
})

test('78. a long opening is never cut before an "if" that sets a condition', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'push' })
  await $.session.append(
    says('I will push the final version of the mod to GitHub tonight, if you test it in your copy first and tell me it works.'),
  )
  await clock.advance(10_000)
  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-1) ?? '')
  expect(said.some(one => one.includes('if you test it in your copy first'))).toBe(true)
})

test('79. a long Mac line keeps its highlight moving: the terminal is wide, and a mark from a wrapped line is the next word', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true, sayMs: 8000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'long' })
  await $.session.append(says('One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen.'))
  await clock.advance(10_000)
  expect(runs.some(argv => argv[0] === 'say' && String(argv[1]).includes('stty cols 4000'))).toBe(true)
})

test('80. even when say counts a wrapped line from its left, every word lights in turn, none rushed at the end', async ($, on) => {
  // The mock wraps after 8 words, as a line too long for the terminal would.
  const { clock } = boot(on, { voice: true, sayMs: 8000, sayWrap: 8 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'long' })
  await $.session.append(says('One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen.'))
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const litAt: Record<string, number> = {}
  for (let step = 0; step < 120; step++) {
    await clock.advance(100)
    const sentence = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen.'.split(' ')
    // The lit box's place in the caption line on screen, named by that line's first word.
    const first = (await band.findAll({ type: 'Text' })).map(one => String(one.text ?? '')).find(word => sentence.includes(word))
    const lit = (await band.findAll({ type: 'Box' })).find(one => one.props.backgroundColor !== undefined && one.key?.startsWith('w'))
    const place = `${first}:${lit?.key}`
    if (lit?.key && litAt[place] === undefined) litAt[place] = clock.now()
  }
  await band.unmount()
  const times = Object.values(litAt).sort((a, b) => a - b)
  const gaps = times.slice(1).map((at, i) => at - (times[i] ?? at))
  expect(times.length).toBeGreaterThanOrEqual(15)
  expect(Math.min(...gaps)).toBeGreaterThanOrEqual(300)
  expect(Math.max(...gaps)).toBeLessThanOrEqual(700)
})

test('81. 🔊 opens a small chooser in place of the icons; a pick closes it and is remembered', async ($, on) => {
  const { clock } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ key: 'mute-sounds' })).toBeUndefined()
  await band.press({ key: 'voice' })
  const picks = (await band.findAll({ type: 'Button' })).map(one => String(one.props.label))
  expect(picks).toEqual(['✓ All on', 'Mute sounds', 'Mute voice', 'Mute all'])
  expect(await band.find({ key: 'pane' })).toBeUndefined()
  await band.press({ key: 'mute-sounds' })
  expect(await band.find({ key: 'mute-sounds' })).toBeUndefined()
  expect((await band.find({ key: 'voice' }))?.props.label).toBe('🔉')
  await band.unmount()
  // Saved with the other settings: after a reload Bob starts from what is stored.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const again = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await again.press({ key: 'voice' })
  expect((await again.find({ key: 'mute-sounds' }))?.props.label).toBe('✓ Mute sounds')
  await again.unmount()
  await clock.advance(10)
})

test('82. Mute sounds: the voice still speaks, but no heartbeat, ding or done sound plays', async ($, on) => {
  const { clock, sounds, runs } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'voice' })
  await band.press({ key: 'mute-sounds' })
  await band.unmount()
  sounds.length = 0
  await $.prompt.submit({ text: 'long job' })
  await clock.advance(30_000)
  await $.session.append(says('Still working on it.'))
  await $.turn.complete({ answer: long('Still working on it.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)
  expect(sounds).toHaveLength(0)
  expect(runs.some(argv => argv[0] === 'say')).toBe(true)
})

test('83. Mute voice: nothing is said, but the heartbeat plays while Claude works and the done sound at the end', async ($, on) => {
  const { clock, sounds, runs } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'voice' })
  await band.press({ key: 'mute-voice' })
  await band.unmount()
  sounds.length = 0
  runs.length = 0
  await $.prompt.submit({ text: 'long job' })
  await clock.advance(30_000)
  expect(sounds.some(one => one.includes('heartbeat.wav'))).toBe(true)
  await $.session.append(says('All finished.'))
  await $.turn.complete({ answer: long('All finished.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)
  expect(runs.some(argv => argv[0] === 'say' || argv.includes('/usr/bin/afplay'))).toBe(false)
  expect(sounds.at(-1)).toContain('done.wav')
})

test('84. while Claude works the heartbeat is steady, every 3 seconds, never a long silence', async ($, on) => {
  const { clock, sounds } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'long job' })
  sounds.length = 0
  await clock.advance(11_500)
  expect(sounds.filter(one => one.includes('heartbeat.wav'))).toHaveLength(4)
})

// The message box as the app keeps it, and the toasts it shows.
function promptBox(on: On, draft = '') {
  const box = { text: draft, toasts: [] as string[] }
  on('prompt.read', () => ({ value: { text: box.text, cursor: box.text.length } as never }))
  on('prompt.fill', (_, e) => {
    box.text = e.mode === 'append' ? `${box.text}${e.text}` : e.text
    return { isFilled: true }
  })
  on('ui.toast', (_, e) => {
    box.toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined }
  })
  return box
}

test('85. click 🎙, talk, click it again: it turns red, a real mic opens, and what you said lands in the message box', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock, runs, sounds } = boot(on, { voice: true, key: true })
  const box = promptBox(on, 'Also')
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'mic' })
  await clock.advance(100)
  const recording = runs.find(argv => argv.includes('avfoundation') && !argv.includes('-list_devices'))
  // Earbuds before the phone app's mic; never the loopback that carries the Mac's own sound.
  expect(recording).toContain(':Baseus Bass BP1 Pro')
  // The same button turns red in its place, the icons around it stay put, and the orb turns red too.
  expect((await band.find({ key: 'mic' }))?.props.label).toBe('🔴')
  expect(await band.find({ key: 'voice' })).toBeDefined()
  expect(String((await band.find({ type: 'Svg' }))?.props.source)).toContain('#E5484D')
  await clock.advance(2000)
  await band.press({ key: 'mic' })
  await clock.advance(1500)
  expect(box.text).toBe('Also Make the button purple.')
  const curl = runs.find(argv => argv[0] === '/usr/bin/curl')
  expect(curl).toContain('model=gpt-4o-mini-transcribe')
  // The key goes to curl on its standard input only.
  expect(curl?.slice(0, -1).join(' ')).not.toContain('sk-test')
  expect(sounds.some(one => one.includes('start.wav'))).toBe(true)
  expect((await band.find({ key: 'mic' }))?.props.label).toBe('🎙')
  await band.unmount()
})

test('86. where the message box cannot take it, what you said waits in the panel with Send', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock, prompts } = boot(on, { voice: false, key: true, heardYou: 'Ship it tonight.' })
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } as never }))
  on('prompt.fill', () => ({ isFilled: false, refusal: 'no_composer' as const }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'mic' })
  await clock.advance(2000)
  await band.press({ key: 'mic' })
  await clock.advance(1500)
  expect((await band.find({ type: 'Text', text: 'Ship it tonight.' }))?.text).toBe('Ship it tonight.')
  await band.press({ key: 'mic-send' })
  await clock.advance(500)
  expect(prompts).toContain('Ship it tonight.')
  await band.unmount()
})

test('87. no OpenAI key: 🎙 says what is needed, and no mic opens', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true, key: false })
  const box = promptBox(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'mic' })
  await clock.advance(500)
  expect(box.toasts.at(-1)).toContain('OpenAI key')
  expect(runs.some(argv => argv.includes('avfoundation'))).toBe(false)
  await band.unmount()
})

test('88. a mic that hears nothing writes nothing out, and the next mic gets its turn', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock, runs } = boot(on, { voice: true, key: true, micLevel: -91 })
  const box = promptBox(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'mic' })
  await clock.advance(3000)
  await band.press({ key: 'mic' })
  await clock.advance(1500)
  expect(runs.some(argv => argv[0] === '/usr/bin/curl')).toBe(false)
  expect(box.text).toBe('')
  expect(box.toasts.at(-1)).toBe("Baseus Bass BP1 Pro heard nothing. Next time I'll listen on Camo Microphone.")
  runs.length = 0
  await band.press({ key: 'mic' })
  await clock.advance(100)
  expect(runs.find(argv => argv.includes('avfoundation') && !argv.includes('-list_devices'))).toContain(':Camo Microphone')
  await band.press({ key: 'mic' })
  await clock.advance(1500)
  await band.unmount()
})

test('89. 🎙 works with the Mac voice picked: it uses your OpenAI key even when the voice does not', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock, runs } = boot(on, { voice: true, key: true, engine: 'mac' })
  const box = promptBox(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'mic' })
  await clock.advance(2000)
  await band.press({ key: 'mic' })
  await clock.advance(1500)
  expect(box.toasts).toEqual([])
  expect(box.text).toBe('Make the button purple.')
  expect(runs.some(argv => argv.some(arg => String(arg).endsWith('realtime-stream.mjs')))).toBe(false)
  await band.unmount()
})

test('90. with Whisper on the Mac, 🎙 needs no key: what you said is written out on the Mac, in English', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock, runs } = boot(on, { voice: true, key: false, whisper: true, heardYou: 'Push it tomorrow.' })
  const box = promptBox(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'mic' })
  await clock.advance(2000)
  await band.press({ key: 'mic' })
  await clock.advance(1500)
  expect(box.toasts).toEqual([])
  expect(box.text).toBe('Push it tomorrow.')
  const whisperRun = runs.find(argv => argv[0] === '/opt/homebrew/bin/whisper-cli')
  expect(whisperRun?.slice(1, 9)).toEqual(['-m', '/.config/bob/ggml-base.en.bin', '-f', '/private/tmp/bob-voice/mic.wav', '-nt', '-np', '-l', 'en'])
  expect(runs.some(argv => argv[0] === '/usr/bin/curl')).toBe(false)
  await band.unmount()
})

test('91. Whisper hearing no words ("[BLANK_AUDIO]") puts nothing in the box and says so', { timeoutMs: 30_000 }, async ($, on) => {
  const { clock } = boot(on, { voice: true, whisper: true, heardYou: '[BLANK_AUDIO]' })
  const box = promptBox(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'mic' })
  await clock.advance(2000)
  await band.press({ key: 'mic' })
  await clock.advance(1500)
  expect(box.text).toBe('')
  expect(box.toasts.at(-1)).toContain("didn't catch any words")
  await band.unmount()
})

test('92. the card puts what you click right under the line, points below; a must-read is said, not repeated in the text', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'will it work for users' })
  await $.session.append(says(long('Not by copying. See [the list](/Users/you/notes/PORT.md).')))
  await $.tool.call({
    tool: 'mcp__bob-talks-back__panel',
    tag: 'Update: not by copying, yes after the port',
    say: 'Not if we copy it as it is.',
    points: ['Keys from two other folders', 'Users need ffmpeg and Whisper'],
    mustRead: 'the list of what changes in the port',
  } as never)
  await $.turn.complete({ answer: long('Not by copying.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(60_000)

  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-2) ?? '')
  expect(said.some(one => one.includes('Open the full reply in the panel: the list of what changes in the port.'))).toBe(true)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'Not if we copy it as it is.' }))?.text).toBe('Not if we copy it as it is.')
  const order = (await band.findAll({})).map(one => String(one.key ?? one.text ?? ''))
  const mustRead = order.indexOf('fullbutton')
  const open = order.findIndex(one => one.startsWith('linkbutton'))
  const firstPoint = order.findIndex(one => one.startsWith('• '))
  expect(mustRead).toBeGreaterThan(-1)
  expect(open).toBeGreaterThan(-1)
  // Must read closes the card at the bottom right, after the points.
  expect(mustRead).toBeGreaterThan(firstPoint)
  expect(open).toBeLessThan(firstPoint)
  await band.unmount()
})

test('93. an opening the voice has started is not said again by the summary, even before its first word lights', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true, sayMs: 2000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'chill' })
  await $.session.append(says(long('Got it, my bad. If the tweet and the repo go out together, the timing is yours.')))
  // The opening's start tone is playing when the summary arrives.
  await clock.advance(10)
  await $.tool.call({
    tool: 'mcp__bob-talks-back__panel',
    tag: 'Question: Launch on the old version, or wait 2 hours?',
    say: 'Got it, my bad. Then posting now is fine. Launch on that, or wait about two hours?',
  } as never)
  await $.turn.complete({ answer: long('Got it, my bad.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(60_000)
  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-2) ?? '')
  expect(said.filter(one => one.includes('Got it, my bad.'))).toHaveLength(1)
})

test('94. an opening the summary replaces during its start tone is never said, so its words are not heard twice', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true, sayMs: 2000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // A while since Bob last spoke: his next line opens with the start tone.
  await clock.advance(30_000)
  await $.prompt.submit({ text: 'chill' })
  await $.session.append(says(long('Got it, my bad. If the tweet and the repo go out together, the timing is yours.')))
  await clock.advance(10)
  await $.tool.call({
    tool: 'mcp__bob-talks-back__panel',
    tag: 'Question: Launch on the old version, or wait 2 hours?',
    say: 'Got it, my bad. Then posting now is fine. Launch on that, or wait about two hours?',
  } as never)
  await $.turn.complete({ answer: long('Got it, my bad.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(60_000)
  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-2) ?? '')
  expect(said.filter(one => one.includes('Got it, my bad.'))).toHaveLength(1)
  expect(said.some(one => one.includes('Then posting now is fine.'))).toBe(true)
})

test('97. a session nobody watches (claude -p, a script) gets no voice, no sound and no panel instructions', async ($, on) => {
  // A -p run: not interactive, and no surface ever attaches.
  const { clock, runs, sounds } = boot(on, { voice: true, surfaces: () => [] })
  on('prompt.compose', () => ({ sections: [] }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const composed = (await $.prompt.compose({ model: 'test', promptModel: 'test', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [], sections: [] } as never)) as { sections: { id: string }[] }
  expect(composed.sections.some(one => one.id.includes(':spoken-line') || one.id.includes(':ask-in-words'))).toBe(false)
  await $.prompt.submit({ text: 'run the build' })
  await $.session.append(says('Building now.'))
  await $.turn.complete({ answer: long('Built.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)
  expect(runs.some(argv => argv[0] === 'say')).toBe(false)
  expect(sounds).toHaveLength(0)
})

test('98. the desktop app starts its sessions not interactive and without a surface, then attaches one: Bob talks there', async ($, on) => {
  let attached: string[] = []
  const { clock, runs } = boot(on, { voice: true, surfaces: () => attached })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  attached = ['desktop']
  await $.prompt.submit({ text: 'hello' })
  await $.session.append(says('Hello there.'))
  await $.turn.complete({ answer: long('Hello there.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)
  expect(runs.some(argv => argv[0] === 'say')).toBe(true)
})

test('99. a crowded question card: the answer buttons right under the question, the say line without the repeated question, and Must read at the bottom right', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'what next' })
  await $.session.append(says(long('GitHub matches your copy.')))
  await $.tool.call({
    tool: 'mcp__bob-talks-back__panel',
    tag: 'Question: Add a costs note and one desktop install test?',
    say: 'GitHub matches your copy exactly. Want a costs note in the README and a desktop test?',
    options: ['Yes, both', 'Only the costs note', 'Ship as is'],
    mustRead: 'the honest list of costs',
  } as never)
  await $.turn.complete({ answer: long('GitHub matches your copy.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const order = (await band.findAll({})).map(one => String(one.key ?? one.text ?? ''))
  const at = (pick: (one: string) => boolean) => order.findIndex(pick)
  const question = at(one => one === 'Add a costs note and one desktop install test?')
  const firstChoice = at(one => one === 'choice0')
  const say = at(one => one === 'GitHub matches your copy exactly.')
  expect(question).toBeGreaterThan(-1)
  expect(firstChoice).toBeGreaterThan(question)
  expect(say).toBeGreaterThan(firstChoice)
  expect(order.some(one => one.includes('Want a costs note'))).toBe(false)
  // Must read with Full reply closes the card at the bottom right, under your message.
  expect(at(one => one === 'fullbutton')).toBeGreaterThan(say)
  expect(at(one => one === 'fullbutton')).toBeGreaterThan(at(one => one === 'what next'))
  await band.unmount()
})

test('100. a summary that starts with the sentence the voice just said says only the rest, never the same words twice', async ($, on) => {
  const { clock, runs } = boot(on, { voice: true, sayMs: 1000 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'did it work' })
  await $.session.append(says(long('Your desktop test worked. In the new chat the mod installed and loaded.')))
  await clock.advance(3000)
  await $.tool.call({
    tool: 'mcp__bob-talks-back__panel',
    tag: 'Done: the desktop test worked',
    say: 'Your desktop test worked: the GitHub version installed, loaded, and said hi.',
  } as never)
  await $.turn.complete({ answer: long('Your desktop test worked.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(60_000)
  const said = runs.filter(argv => argv[0] === 'say').map(argv => argv.at(-2) ?? '')
  expect(said.filter(one => /your desktop test worked/i.test(one))).toHaveLength(1)
  expect(said.some(one => one.startsWith('The GitHub version installed, loaded, and said hi.'))).toBe(true)
})

test('101. Full reply opens in the side panel, Copy all at its top above the text; the band keeps its button in place', async ($, on) => {
  const { clock } = boot(on, { voice: false, gist: 'Update: The plan is set.' })
  const opened: string[] = []
  on('ui.open', (_, e) => (opened.push(e.id), { value: { isPlaced: true } }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'what is the plan' })
  const reply = Array.from({ length: 12 }, (_, at) => `Point ${at + 1} of the plan has a few words in it.`).join(' ')
  await $.session.append(says(reply))
  await $.turn.complete({ answer: reply, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  await band.press({ key: 'fullbutton' })
  expect(opened).toContain('bob')
  const pane = await $.ui.mount({ ...PANE_SITE, surface: 'desktop' })
  const order = (await pane.findAll({})).map(one => (one.type === 'Markdown' ? 'markdown' : String(one.key ?? '')))
  expect(order.indexOf('copyfull')).toBeLessThan(order.indexOf('markdown'))
  await pane.unmount()
  await band.unmount()
})

test('102. a card too tall for the band keeps Full reply in view: the points give way first, then the say line is cut with …', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'crowded' })
  await $.session.append(says(long('A crowded reply.')))
  const say = 'This card is the most crowded case there is, with four long choices to pick between, a long say line that keeps going on and on about everything that happened, and three points after it.'
  await $.tool.call({
    tool: 'mcp__bob-talks-back__panel',
    tag: 'Question: Crowded test 3 — is this card clean enough to ship to everyone today?',
    say,
    points: ['Copy and Open sit under the orb now', 'Must read closes the card at the bottom right', 'All the tests pass on both copies'],
    options: ['Looks good, push it', 'Still too crowded', 'Bigger text please', 'Another crowded test'],
    mustRead: 'crowded test',
  } as never)
  await $.turn.complete({ answer: long('A crowded reply.'), durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await band.find({ key: 'fullbutton' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^• / })).toBeUndefined()
  const shown = String((await band.find({ type: 'Text', text: /^This card is the most crowded/ }))?.text ?? '')
  expect(shown.endsWith('…')).toBe(true)
  expect(shown.length).toBeLessThan(say.length)
  await band.press({ key: 'fullbutton' })
  // Opened on the right, the side panel shows everything the band left out.
  const pane = await $.ui.mount({ ...PANE_SITE, surface: 'desktop' })
  expect((await pane.findAll({ type: 'Text', text: /^• / })).length).toBe(3)
  await pane.unmount()
  await band.unmount()
})

test('103. a card that fits shows its say line and points whole', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'short' })
  await $.session.append(says('All set.'))
  await $.tool.call({ tool: 'mcp__bob-talks-back__panel', tag: 'Done: all set', say: 'Everything is in place.', points: ['One point', 'Two points'] } as never)
  await $.turn.complete({ answer: 'All set.', durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await band.find({ type: 'Text', text: 'Everything is in place.' }))?.text).toBe('Everything is in place.')
  expect((await band.findAll({ type: 'Text', text: /^• / })).length).toBe(2)
  await band.unmount()
})

test('104. a long reply that asks a question with choices still gets Full reply', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'keep it?' })
  const reply = Array.from({ length: 12 }, (_, at) => `Point ${at + 1} of the answer has a few words in it.`).join(' ')
  await $.session.append(says(reply))
  await $.tool.call({ tool: 'mcp__bob-talks-back__panel', tag: 'Question: Keep it?', say: 'It only cuts crowded cards.', options: ['Keep it', 'No trimming'] } as never)
  await $.turn.complete({ answer: reply, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(String((await band.find({ key: 'fullbutton' }))?.props.label).trim()).toBe('Full reply')
  await band.unmount()
})

test('105. many things to copy and open: those that fit show under the orb, the rest behind "+N more", which shows them all', async ($, on) => {
  const { clock } = boot(on, { voice: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'everything' })
  const blocks = ['npm run build', 'npm run test', 'npm run deploy', 'git push origin main'].map(one => `\`\`\`bash\n${one}\n\`\`\``).join('\n\n')
  const reply = long(`Run these:\n\n${blocks}\n\nFiles: [a.md](/x/a.md), [b.md](/x/b.md), [c.md](/x/c.md).`)
  await $.session.append(says(reply))
  await $.turn.complete({ answer: reply, durationMs: 5, isAborted: false, turnId: 't' })
  await clock.advance(30_000)
  const band = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const count = async () => (await band.findAll({ type: 'Button' })).filter(one => /^(Copy|Open)$/.test(String(one.props.label).trim())).length
  const before = await count()
  expect(before).toBeLessThan(7)
  expect(String((await band.find({ key: 'sidemore' }))?.props.label)).toBe(`+${7 - before} more`)
  await band.press({ key: 'sidemore' })
  const pane = await $.ui.mount({ ...PANE_SITE, surface: 'desktop' })
  const inPane = (await pane.findAll({ type: 'Button' })).filter(one => /^(Copy|Open)$/.test(String(one.props.label).trim())).length
  expect(inPane).toBe(7)
  await pane.unmount()
  await band.unmount()
})

test('106. out of the box the free Mac voice speaks, even with an OpenAI key', async ($, on) => {
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

test('107. /bob normal speaks with OpenAI text-to-speech, /bob live with the live voice, /bob mac back to free', async ($, on) => {
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
