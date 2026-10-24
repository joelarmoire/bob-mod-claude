import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { CaptionLine, Choice, Opened, PanelAsk, PlanItem, Reply, Settings } from '../types'

const reply = atom({ plugin: 'bob-talks-back', key: 'reply' } as const, null)
const owner = atom({ plugin: 'bob-talks-back', key: 'owner' } as const, '')
const settings = atom({ plugin: 'bob-talks-back', key: 'settings' } as const, {
  isOn: true,
  isVoiceOn: true,
  isCardInPane: false,
  isCompact: false,
})
const PANE = 'bob'

const STORE_KEY = 'settings-v2'
// Between tool steps the status line takes turns with these every 3 seconds.
const IDLE_WORDS = ['Thinking', 'Cooking']
const PACE_KEY = 'say-pace'
// Diagnostics while Bob is being tuned: what he heard, said and drew.
const LOG_PATH = '/tmp/bob-talks-back.log'
const MAX_WORDS = 6
// A reply this short is spoken word for word instead of summarized.
const SHORT_REPLY_WORDS = 25
// The most task-list rows the panel shows at once.
const PLAN_ROWS = 6
// Words a caption line would rather start with when a phrase must break.
const LINK_WORDS = new Set(['and', 'but', 'or', 'so', 'that', 'which', 'while', 'with', 'because', 'when', 'then', 'to', 'for', 'if'])
const MAX_PROMPT = 400
// Under the message box your message gets about two lines; ⤢ shows it whole.
const BAND_PROMPT = 120
// The system voice says about three words a second; a word's share of that
// time grows with its length.
const MS_PER_WEIGHT = 70
// A finished line stays up this long before the next one takes its place.
const LINE_HOLD_MS = 300
// The soft tone before Bob speaks gets this head start.
const TONE_GAP_MS = 220
// Lines closer together than this are one stretch of talking: no tone between.
const RUN_GAP_MS = 2500
// A line that needs you opens with these words, after the ask ding.
const QUESTION_INTRO = 'Question for you.'
const ATTENTION_INTRO = 'Needs your attention.'
const DING_GAP_MS = 650
// The system voice at a fixed rate, so the highlight can keep up; `pace`
// learns how long it really takes on this Mac.
// The Mac voice, used only without an OpenAI key: a man's, like the others.
const MAC_VOICE = 'Daniel'
const SAY_WPM = 195
const SAY_MS_PER_WEIGHT = 44
const SAY_START_MS = 300
// A clip takes a moment to start playing once handed over.
const CLIP_START_MS = 300
// What afplay takes past launching to make its first sound.
const AFPLAY_START_MS = 60
// How long after a highlight is set the panel shows it.
const REPAINT_MS = 300
const SYNC_STEP_MS = 100
// A beat after a clip's last sound before the next line may start.
const CLIP_TAIL_MS = 500
// Below this level a sample counts as the silence around a take.
const SILENCE_LEVEL = 400
// A quiet stretch this long inside a clip is a pause between phrases.
const PAUSE_MS = 140
const CLIP_DIR = '/private/tmp/bob-voice'
// Answers you give in the panel reach the hook that waits on them as files.
const ANSWER_WAIT_MS = 600_000
// Only one chat speaks at a time: the one holding this folder.
const VOICE_LOCK = '/private/tmp/bob-voice/speaking'
const VOICE_LOCK_STALE_S = 45
const FAILURE_RED = '#E5484D'
const HELPER_POLL_S = 2
// A multiple-choice question sends itself this long after your last click.
const MULTI_SEND_MS = 1500
// A click's answer that hasn't reached Claude by then is dropped, never sent late.
const ANSWER_FRESH_MS = 60_000
// Retry that hasn't started a turn by then goes in the message box instead.
const RETRY_CHECK_MS = 8000
// Two files taken in turn, so a new line never overwrites one still closing.
const CLIP_PATHS = [`${CLIP_DIR}/line-a.wav`, `${CLIP_DIR}/line-b.wav`]
const GIST_MODEL = 'claude-haiku-5-5'
const GIST_SYSTEM = `You turn an AI coding assistant's reply into what its user hears.
The user will NOT read the reply, so what you write must stand on its own.
Line 1: a label, then at most 10 casual words:
"Question: " and the question itself, when the reply asks the user something;
"Needs you: " and what to do, when the user has to act;
"Done: " and what got done, when the work is finished;
"Update: " and the news, otherwise.
Line 2: "Say: " then one or two short sentences, at most 30 words, with what
the reply actually tells the user (the facts, the why, what it means for
them), so a listener who never saw it understands and could answer. Make it
sound like a person talking to a friend: warm, relaxed, contractions, whole
sentences that flow, never a report or a list. Do not repeat line 1. Leave out
filler such as apologies or "let me explain".
If the reply asks the user to pick between named options, add one line per
option, at most 4, like "> Brewing": the option itself in at most 4 words,
as the user would answer it.
Speak as Claude, the assistant, in the first person ("I fixed..."); never use
any other name for it.
Keep who does what exactly as in the reply: "you" is the user, "I" is the
assistant; never swap them.
Answer with those lines alone.`
const CLAUDE_ORANGE = '#D97757'
// One accent only: the spoken word and a reply that needs you wear Claude's orange.
const HIGHLIGHT = '#D97757'
// The chip you picked: a faint wash of the same orange.
const CHIP_HOVER = '#D9775733'
// Spaces inside the button's label, so the clickable part fills the chip.
const CHIP_PAD = '\u2002'
const SAMPLE_RATE = 24000
// Where the person already keeps an OpenAI key; read when Bob speaks, kept in
// memory only, never logged or stored.
const KEY_FILES = async ($: EngineInterface) => [`${(await $.env.get('HOME')) ?? ''}/.config/bob/openai.env`]
const KEY_LINE = /^\s*(?:export\s+)?OPENAI(?:_API)?_KEY\s*=\s*["']?([^"'\s#]+)/m
const VOICE_STYLE =
  'Voice: a deep, warm, slightly gravelly older narrator with quiet gravitas and real kindness, like a beloved nature documentary. Tone: calm, assured, gently amused, as if smiling while talking. Delivery: natural and alive, conversational rather than read aloud, with soft emphasis on the words that matter. Pace: measured, moderate, never slow or dragging, with brief natural pauses. Articulate clearly.'
// The most natural OpenAI voice this account takes, tried in order; one that
// is refused is skipped from then on.
// The speech model has no ash, so its fallback goes to the deepest it has.
const VOICE_ORDER = ['ash', 'onyx']
// The live model's male voices, deepest first.
const SAMPLE_VOICES = ['ash', 'echo', 'ballad', 'verse', 'cedar']
const ALL_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar']
// OpenAI's audio plays at the speed it was spoken.
const PLAYBACK_RATE = 1
// afplay then speeds it up this much, keeping the pitch: deep, just quicker.
const VOICE_SPEED = 1
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
// The spark's rays, longest 1: uneven like Claude's own mark.
const RAYS = [1, 0.74, 0.92, 0.68, 0.98, 0.8, 0.7, 0.95, 0.76, 0.9, 0.66, 0.86]

type Mood = 'idle' | 'thinking' | 'talking' | 'waiting'
// `speed`: how much faster than spoken afplay plays it, the pitch kept.
// `voiced`: where in the clip the voice actually sounds, in played ms; the
// highlight moves only through these and holds still in the pauses.
// `heard`: when each word is actually spoken, in played ms, from a
// transcription of the clip; the exact clock for the highlight when present.
// `path`: a file the live voice already wrote, ready to play as is.
type Speech = {
  base64?: string
  path?: string
  ms: number
  speed?: number
  voiced?: [number, number][]
  heard?: { text: string; at: number }[]
}
type Spoken = { line: number; word: number; text: string }

let voice = 'ash'
let keyPath: string | undefined
// After OpenAI refuses (no credits, bad key), Bob stops asking for a while so
// a refusal never holds up his line.
let openAiPausedUntil = 0
const OPENAI_PAUSE_MS = 10 * 60 * 1000
const OPENAI_WAIT_MS = 5000
// The live voice: OpenAI's Realtime model through a small Node helper.
const LIVE_HELPER = ($: EngineInterface) => `${$.plugin.root}/helpers/realtime-voice.mjs`
const LIVE_MODEL = 'gpt-realtime-2.1'
// Which voice speaks, picked with /bob mac, /bob normal or /bob live:
// - mac: the Mac's own voice. Free, needs nothing, and the default.
// - normal: OpenAI's text-to-speech voice (gpt-4o-mini-tts). Cheap; each line starts a beat later.
// - live: OpenAI's realtime voice, streamed: starts at once and lights each word as it is said (the demo's voice).
// The two OpenAI voices need a key; without one the Mac's voice speaks.
type VoiceEngine = 'mac' | 'normal' | 'live'
const VOICE_ENGINES: readonly string[] = ['mac', 'normal', 'live']
const ENGINE_NAMES: Record<VoiceEngine, string> = {
  mac: "the Mac's own voice (free)",
  normal: "OpenAI's normal voice",
  live: "OpenAI's live voice",
}
async function engineOf($: EngineInterface): Promise<VoiceEngine> {
  const picked = (await read($, settings)).voiceEngine
  return picked === 'normal' || picked === 'live' ? picked : 'mac'
}
// The OpenAI key, only while one of the OpenAI voices is picked.
async function openAiKey($: EngineInterface): Promise<string | undefined> {
  return (await engineOf($)) === 'mac' ? undefined : findKey($)
}
const NODE_PATH = '/usr/bin/env'
const LIVE_WAIT_MS = 12_000
// The streamed live voice, and the pace it is learned to speak at (ms per
// character), which lights words until their exact times arrive.
const STREAM_HELPER = ($: EngineInterface) => `${$.plugin.root}/helpers/realtime-stream.mjs`
const STREAM_PACE_KEY = 'stream-pace'
// From the helper reporting the first sound to it leaving the speakers.
const STREAM_LEAD_MS = 120
// The backup voice joins the race after this; past the deadline, the Mac voice.
const BACKUP_AFTER_MS = 3000
const VOICE_DEADLINE_MS = 15_000
const VOICE_STYLES = ['pro', 'narrator']
// The live model barely changes pace from wording; pro plays at this speed.
const PRO_SPEED = 1
// While Claude works: the first typing burst after this many seconds, then one
// every TYPING_GAP_S to twice that.
const TYPING_FIRST_S = 4
const TYPING_GAP_S = 7
let isPlaying = false
let stopClip: AbortController | undefined
let ticker: Timer | undefined
let pace = 1
// How long OpenAI clips really take against their length, learned as they play.
let isSaying = false
let isClipPlaying = false
let clipTurn = 0
let liveTurn = 0
let isSpeaking = false
let lastSpokeAt = 0
// The sentence Bob has taken up (fetching its voice or saying it): the summary
// queues behind it instead of replacing it.
let taken: { id: number; end: number } | undefined
// The reply whose summary is being written; Bob holds his next line for it.
let finishingId: number | undefined
const playingCues = new Set<AbortController>()
const voiceCache = new Map<string, Promise<Speech | undefined>>()
let clipLead = CLIP_START_MS
let isLeadMeasured = false
const isLiveVoiceOn = true
let hasUsedLive = false
let streamPace = 80
let isStreaming = false
let helperTicker: Timer | undefined
// Why the last turn died, from the app's StopFailure report.
let lastFailure: string | undefined
// The answer a click sent, until it reaches Claude: its words, its reply, when.
let pendingAnswer: { text: string; id: number; at: number } | undefined
let lastTurnStartAt = 0
const logLines: string[] = []
let lastDrawn = ''
// Rows drawn while no reply was being captioned: history, never collapsed.
const settled = new Set<string>()

// Markdown to caption lines of a few words; the lines of one sentence share
// its number, as the voice says a sentence in one go.
// Markdown to plain words: code and tables stay in the chat.
function toPlain(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, '\n(copy it below)\n')
    .replace(/^\s*\|.*\|\s*$/gm, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*(#+|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_>~]/g, '')
}

function toLines(markdown: string, firstSentence: number): CaptionLine[] {
  const plain = toPlain(markdown)

  const sentences = plain
    .split(/(?<=[.!?;])\s+|\n+/)
    .map(sentence => sentence.trim())
    .filter(sentence => /[\p{L}\p{N}]/u.test(sentence))

  // Only the headline: the rest of the message waits in the card and the chat.
  // An opener of a few words ("Quickest", "Got it") takes the next sentence along.
  const [first, second] = sentences
  if (first === undefined) return []
  const headline = first.split(/\s+/).length < 4 && second !== undefined ? `${first} ${second}` : first
  return toCaptionLines(headline, firstSentence)
}

// A sentence cut into caption lines at its natural breaks (commas, colons,
// dashes), each a few words that read as one phrase; a long phrase is split
// evenly, a two-word scrap joins its neighbour.
function phraseChunks(text: string): string[][] {
  const phrases = text
    .split(/(?<=[,;:.!?])\s+|\s+(?=[-–—]\s)/)
    .map(phrase => phrase.split(/\s+/).filter(word => word !== ''))
    .filter(words => words.length > 0)
  const merged: string[][] = []
  for (const words of phrases) {
    const last = merged.at(-1)
    if (last !== undefined && (last.length < 3 || words.length < 3)) {
      last.push(...words)
    } else {
      merged.push([...words])
    }
  }
  return merged.flatMap(splitPhrase)
}

// A phrase longer than a caption line breaks before a linking word ("that",
// "while", "and") when one sits in a good spot, else evenly; no scrap under
// three words is left on its own.
function splitPhrase(words: string[]): string[][] {
  if (words.length <= MAX_WORDS) return [words]
  const chunks: string[][] = [[]]
  words.forEach((word, at) => {
    const chunk = chunks.at(-1) ?? []
    const isLink = LINK_WORDS.has(word.toLowerCase())
    const left = words.length - at
    if (chunk.length >= MAX_WORDS || (isLink && chunk.length >= 3 && left >= 3)) chunks.push([word])
    else chunk.push(word)
  })
  // A scrap at the end borrows words from the line before it, so both read.
  const last = chunks.at(-1)
  const before = chunks.at(-2)
  if (last !== undefined && before !== undefined && last.length < 3) {
    last.unshift(...before.splice(-(3 - last.length)))
  }
  return chunks.filter(chunk => chunk.length > 0)
}

type Sentence = ReturnType<typeof sentenceAt>


// After the last queued line: the done chime, or the heartbeat while Claude
// still works; nothing if more is about to be said.
async function closingCue($: EngineInterface, id: number, line: number, isFinal: boolean, isForYou: boolean) {
  const after = await read($, reply)
  lastSpokeAt = await $.clock.now()
  const isMoreToSay = after !== null && sentenceAt(after.lines, line).end < after.lines.length
  if (after === null || after.id !== id || isMoreToSay) return
  if (isFinal && !isForYou) cue($, 'done', 0.4)
  else if (after.isWorking) cue($, 'heartbeat', 0.8)
}

// Past the sentence, if it is still the one in place.
async function moveOn($: EngineInterface, id: number, line: number, sentence: Sentence) {
  await update($, reply, now =>
    now !== null && now.id === id && now.line < sentence.end && sentenceAt(now.lines, line).text === sentence.text
      ? { ...now, line: sentence.end, word: -1 }
      : now,
  )
}

// A line no voice could say, shown word by word at reading pace.
async function showSilently($: EngineInterface, id: number, sentence: Sentence) {
  const startedAt = await $.clock.now()
  let said = 0
  for (const spoken of sentence.words) {
    const delay = startedAt + said * MS_PER_WEIGHT - (await $.clock.now())
    if (delay > 0) await wait($, delay)
    if (!(await highlight($, id, spoken))) return
    said += weightOf(spoken.text)
  }
}

// One line in the live voice, streamed: the helper plays it as OpenAI makes
// it and reports when the sound starts and, once known, when each word is
// said. Until then words light at the voice's learned pace; then exactly.
async function streamLine(
  $: EngineInterface,
  id: number,
  sentence: Sentence,
  opening?: { name: 'ask' | 'start'; leadMs: number },
): Promise<'done' | 'cut' | 'failed'> {
  const { voiceStyle, syncMs } = await read($, settings)
  const style = typeof voiceStyle === 'string' && VOICE_STYLES.includes(voiceStyle) ? voiceStyle : 'narrator'
  // Tagged with this chat's name, so only this chat can stop it; the helper
  // holds the sound back by the ding's lead once it is ready to play.
  const child = $.process.spawn({
    argv: [NODE_PATH, 'node', STREAM_HELPER($), voice, LIVE_MODEL, style, await read($, owner), String(opening?.leadMs ?? 0)],
    input: sentence.text,
  })
  isStreaming = true
  let startedAt: number | undefined
  let heard: { text: string; at: number }[] = []
  let lengthMs: number | undefined
  let isOver = false
  let failure = ''
  const reading = (async () => {
    let pending = ''
    try {
      for await (const chunk of child) {
        if (chunk.stream === 'stderr') {
          failure += chunk.text
          continue
        }
        pending += chunk.text
        for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
          const line = pending.slice(0, end)
          pending = pending.slice(end + 1)
          let event: { event?: unknown; ms?: unknown; words?: { word?: unknown; at?: unknown }[] }
          try {
            event = JSON.parse(line) as typeof event
          } catch {
            continue
          }
          // The ding plays as the voice is ready, just ahead of it.
          if (event.event === 'ready' && opening !== undefined) cue($, opening.name, 0.7)
          if (event.event === 'start' && startedAt === undefined) startedAt = await $.clock.now()
          if (event.event === 'words') {
            lengthMs = typeof event.ms === 'number' ? event.ms : undefined
            heard = (event.words ?? [])
              .filter(one => typeof one.word === 'string' && typeof one.at === 'number')
              .map(one => ({ text: String(one.word), at: Number(one.at) }))
          }
        }
      }
    } catch (error) {
      failure ||= reasonOf(error)
    }
    isOver = true
    isStreaming = false
  })()

  // While it connects, a new message or a skip cancels it before any sound.
  while (startedAt === undefined && !isOver) {
    await wait($, 30)
    const now = await read($, reply)
    // A line that moved on is left to play out (stopping is hush's job, on
    // your skip or new message): a reload's old copy must never cut it.
    if (now === null || now.id !== id || now.line >= sentence.end) return 'cut'
  }
  if (startedAt === undefined) {
    log($, `voice: live voice failed: ${failure.trim().slice(0, 200) || 'no sound'}`)
    const voiceNote = /quota|billing|credit|insufficient/i.test(failure) ? 'voice off · out of OpenAI credit' : 'voice off'
    await update($, reply, now => (now === null ? now : { ...now, voiceNote }))
    return 'failed'
  }
  if ((await read($, reply))?.voiceNote) await update($, reply, now => (now === null ? now : { ...now, voiceNote: undefined }))
  if (!hasUsedLive) log($, `voice: speaking with the live voice (${LIVE_MODEL}, ${voice}), streamed`)
  hasUsedLive = true
  isSpeaking = true

  const texts = sentence.words.map(one => one.text)
  const before: number[] = []
  texts.reduce((sum, word, at) => ((before[at] = sum), sum + word.length + 1), 0)
  const shift = (typeof syncMs === 'number' ? syncMs : 0) - REPAINT_MS + STREAM_LEAD_MS
  let isCut = false
  for (const [index, spoken] of sentence.words.entries()) {
    // Re-checked every 120 ms, so exact word times that arrive mid-line take
    // over from the estimate at once.
    for (;;) {
      const exact = heard.length > 0 ? alignWords(texts, heard, lengthMs ?? 0)[index] : undefined
      const target = index === 0 ? 0 : (exact ?? (before[index] ?? 0) * streamPace)
      const delay = startedAt + target + shift - (await $.clock.now())
      if (delay <= 0 || isOver) break
      await wait($, Math.min(delay, 120))
    }
    if (isOver && index > 0) break
    if (!(await highlight($, id, spoken))) {
      isCut = true
      break
    }
  }
  if (isCut) {
    isSpeaking = false
    return 'cut'
  }
  await reading
  isSpeaking = false

  // The pace the voice really spoke at, for the next line's estimate.
  const last = heard.at(-1)
  const lastIndex = last === undefined ? -1 : texts.length - 1
  if (last !== undefined && lastIndex > 0 && (before[lastIndex] ?? 0) > 0) {
    streamPace = Math.min(200, Math.max(30, 0.5 * streamPace + (0.5 * last.at) / (before[lastIndex] ?? 1)))
    void $.store.set(STREAM_PACE_KEY, streamPace)
  }
  return 'done'
}

// This chat's voice still playing (a line from before a reload, or one cut
// short in the panel but left to finish).
async function isOldVoicePlaying($: EngineInterface) {
  const found = await $.process.run(['pgrep', '-f', `realtime-stream.mjs .*${await read($, owner)}`]).catch(() => undefined)
  return found?.exitCode === 0
}

// Waits out a line still playing from before a reload, 30 s at most.
async function untilOldVoiceEnds($: EngineInterface) {
  for (let waited = 0; waited < 30_000 && (await isOldVoicePlaying($)); waited += 200) await wait($, 200)
}

// Stops this chat's voice now, never another chat's. SIGUSR2: the helper
// rides out the other signals (a reload's), and takes its player with it.
function stopStream($: EngineInterface) {
  void read($, owner).then(me =>
    $.process.run(['pkill', '-USR2', '-f', `realtime-stream.mjs .*${me}`]).catch(() => undefined),
  )
}

async function isStillAt($: EngineInterface, id: number, line: number, text: string) {
  const now = await read($, reply)
  return now !== null && now.id === id && now.line === line && sentenceAt(now.lines, line).text === text
}

function sentenceAt(lines: CaptionLine[], start: number) {
  let end = start
  while (lines[end] !== undefined && lines[end]?.sentence === lines[start]?.sentence) end++
  const words: Spoken[] = lines
    .slice(start, end)
    .flatMap((one, offset) => one.words.map((text, word) => ({ line: start + offset, word, text })))
  return { end, words, text: words.map(one => one.text).join(' ') }
}

const weightOf = (word: string) => word.length + 2

const SPINNER = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="none" stroke="${CLAUDE_ORANGE}" stroke-opacity="0.25" stroke-width="2"/><path d="M8 2 a6 6 0 0 1 6 6" fill="none" stroke="${CLAUDE_ORANGE}" stroke-width="2" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="0.9s" repeatCount="indefinite"/></path></svg>`

type PlanInput = {
  items?: { content?: unknown; status?: unknown }[]
  advance?: unknown
  done?: unknown
  start?: unknown
}

// Follows the task list Claude keeps in the app, as its update_plan calls
// change it.
function nextPlan(plan: PlanItem[], input: PlanInput): PlanItem[] {
  if (Array.isArray(input.items)) {
    return input.items.map(item => ({
      text: String(item.content ?? ''),
      status: item.status === 'completed' ? 'done' : item.status === 'in_progress' ? 'doing' : 'todo',
    }))
  }
  const items = plan.map(item => ({ ...item }))
  const mark = (at: number, status: PlanItem['status']) => {
    const item = items[at]
    if (item) item.status = status
  }
  if (input.advance === true) {
    mark(items.findIndex(item => item.status === 'doing'), 'done')
    mark(items.findIndex(item => item.status === 'todo'), 'doing')
  }
  if (Array.isArray(input.done)) input.done.forEach(n => mark(Number(n) - 1, 'done'))
  if (typeof input.start === 'number') mark(input.start - 1, 'doing')
  return items
}

// The question and answers of the app's next-step box, from its wrap-up call.
function choiceOf(input: Record<string, unknown>): Choice | null {
  if (typeof input.ask !== 'string' || input.ask.trim() === '') return null
  const actions = Array.isArray(input.actions) ? (input.actions as Record<string, unknown>[]) : []
  const options = actions
    .filter(action => action.action === undefined && typeof action.label === 'string')
    .map(action => ({
      label: String(action.label),
      text: typeof action.message === 'string' && action.message !== '' ? action.message : String(action.label),
    }))
  return { ask: input.ask.trim(), options }
}

function activityOf(tool: string, input: Record<string, unknown>): string {
  const file = typeof input.file_path === 'string' ? input.file_path.split('/').pop() : undefined
  if (tool === 'Read') return file ? `Reading ${file}` : 'Reading'
  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    return file ? `Editing ${file}` : 'Editing'
  }
  if (tool === 'Bash') {
    return typeof input.description === 'string' ? input.description : 'Running a command'
  }
  if (tool === 'Grep' || tool === 'Glob') return 'Searching the code'
  if (tool === 'WebSearch' || tool === 'WebFetch') return 'Looking online'
  if (tool === 'Agent' || tool === 'Task') return 'Asking a helper'
  if (tool === 'AskUserQuestion') return 'Waiting for you'
  if (tool.startsWith('mcp__ccd_')) return 'Organizing'
  return 'Using a tool'
}

// The commands in a reply's code blocks, each a Copy chip on the card.
function commandsOf(markdown: string): string[] {
  return [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)]
    .map(match => (match[1] ?? '').trim())
    .filter(text => text !== '')
}

// What a tool call put on the right of the window (files, a page, a pane):
// each with what its Open chip opens; empty for any other call.
function openedOf(tool: string, input: Record<string, unknown>, result: unknown): Opened[] {
  const nameOf = (path: unknown) => (typeof path === 'string' ? path.split('/').pop() : undefined)
  if (tool === 'SendUserFile' && Array.isArray(input.files)) {
    return input.files
      .filter((path): path is string => typeof path === 'string' && path !== '')
      .map(path => ({ name: nameOf(path) ?? path, target: path }))
  }
  if (tool === 'Artifact') {
    const action = input.action ?? 'publish'
    if (input.asset === true || (action !== 'publish' && action !== 'open')) return []
    const url = /https:\/\/claude\.ai\/[^\s"'\\)]+/.exec(JSON.stringify(result ?? ''))?.[0]
    const target = url ?? (typeof input.url === 'string' ? input.url : typeof input.file_path === 'string' ? input.file_path : '')
    return [{ name: nameOf(input.file_path) ?? 'the page', target }]
  }
  if (tool === 'mcp__ccd_view__show_pane') {
    return [{ name: typeof input.pane === 'string' ? `the ${input.pane}` : 'a panel', target: '' }]
  }
  return []
}

function listOf(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

// A file name as said aloud: no extension, dashes and underscores as spaces.
const spokenName = (name: string) => name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[-_]+/g, ' ')

// What the reply's closing adds on top of the summary: where to look, what to copy.
function notesOf(current: Reply | null, answer: string): string[] {
  const shown = (current?.opened ?? []).map(one => one.name)
  const commands = commandsOf(answer).length
  return [
    ...(shown.length > 0 ? [`I opened ${listOf(shown.map(spokenName))} on the right.`] : []),
    ...(commands === 1 ? ['The command is ready to copy below.'] : []),
    ...(commands > 1 ? ['The commands are ready to copy below.'] : []),
  ]
}

function clockOf(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function moodOf(current: Reply | null): Mood {
  if (current === null) return 'idle'
  if (current.line < current.lines.length && current.word >= 0) return 'talking'
  // A reply saved before Bob tracked questions has no `waiting` at all.
  if (current.waiting) return 'waiting'
  if (current.line < current.lines.length) return 'thinking'
  return current.isWorking ? 'thinking' : 'idle'
}

function spark(mood: Mood, isBouncing = false): string {
  // Waiting on you, the spark all but stops and glows slowly.
  const spin = { idle: '60s', thinking: '4s', talking: '24s', waiting: '900s' }[mood]
  const beat = { idle: '3.2s', thinking: '1.2s', talking: '0.42s', waiting: '2.6s' }[mood]
  const [small, big] = { idle: [0.97, 1.02], thinking: [0.9, 1], talking: [0.86, 1.08], waiting: [0.97, 1.05] }[mood]
  const rays = RAYS.map((length, at) => {
    const angle = (at / RAYS.length) * 2 * Math.PI + (at % 2 === 0 ? 0.05 : -0.04)
    const [x, y] = [Math.cos(angle), Math.sin(angle)]
    const [inner, outer] = [5, 5 + 28 * length]
    return `<line x1="${(x * inner).toFixed(1)}" y1="${(y * inner).toFixed(1)}" x2="${(x * outer).toFixed(1)}" y2="${(y * outer).toFixed(1)}"/>`
  }).join('')

  // Done: one spring up, a smaller second hop, then rest. It plays once, as the
  // finished card first appears.
  const bounce = isBouncing
    ? `<animateTransform attributeName="transform" type="translate" values="0 0;0 -6;0 0;0 -2.5;0 0" keyTimes="0;0.3;0.55;0.78;1" dur="0.9s" begin="0.15s" fill="freeze"/>`
    : ''

  // Thinking: a soft orange glow breathes slowly behind the spark.
  const halo =
    mood === 'thinking'
      ? `<defs><radialGradient id="glow"><stop offset="0%" stop-color="${CLAUDE_ORANGE}" stop-opacity="0.55"/><stop offset="60%" stop-color="${CLAUDE_ORANGE}" stop-opacity="0.18"/><stop offset="100%" stop-color="${CLAUDE_ORANGE}" stop-opacity="0"/></radialGradient></defs><circle r="40" fill="url(#glow)"><animate attributeName="opacity" values="0.25;0.9;0.25" dur="3.2s" repeatCount="indefinite"/><animate attributeName="r" values="34;40;34" dur="3.2s" repeatCount="indefinite"/></circle>`
      : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-40 -40 80 80" width="88" height="88">
${halo}<g>${bounce}
<g stroke="${CLAUDE_ORANGE}" stroke-width="6.5" stroke-linecap="round">
<animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="${spin}" repeatCount="indefinite"/>
<g><animateTransform attributeName="transform" type="scale" values="${small};${big};${small}" dur="${beat}" repeatCount="indefinite"/>${rays}</g>
</g>
</g>
</svg>`
}

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let buffer = 0
  let bits = 0
  let at = 0
  for (const char of clean) {
    buffer = ((buffer << 6) | BASE64.indexOf(char)) & 0xffffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      bytes[at++] = (buffer >> bits) & 0xff
    }
  }
  return bytes.subarray(0, at)
}

function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (let at = 0; at < bytes.length; at += 3) {
    const [a = 0, b = 0, c = 0] = [bytes[at], bytes[at + 1], bytes[at + 2]]
    const triple = (a << 16) | (b << 8) | c
    text += BASE64[(triple >> 18) & 63]
    text += BASE64[(triple >> 12) & 63]
    text += at + 1 < bytes.length ? BASE64[(triple >> 6) & 63] : '='
    text += at + 2 < bytes.length ? BASE64[triple & 63] : '='
  }
  return text
}

// 16-bit mono PCM at 24 kHz, as OpenAI sends it, in a WAV file.
function toWav(pcm: Uint8Array): Uint8Array {
  const wav = new Uint8Array(44 + pcm.length)
  const view = new DataView(wav.buffer)
  const ascii = (at: number, text: string) =>
    [...text].forEach((char, offset) => view.setUint8(at + offset, char.charCodeAt(0)))
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length, true)
  ascii(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  // Claiming a higher rate than recorded plays the clip faster.
  const rate = Math.round(SAMPLE_RATE * PLAYBACK_RATE)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, pcm.length, true)
  wav.set(pcm, 44)
  return wav
}

// Read afresh each time, so a key pasted in while Bob runs is used at once.
async function findKey($: EngineInterface): Promise<string | undefined> {
  const fromEnv = await $.env.get('OPENAI_API_KEY')
  if (fromEnv) return fromEnv
  for (const path of await KEY_FILES($)) {
    const text = await $.fs.read(path).catch(() => undefined)
    const key = typeof text === 'string' ? KEY_LINE.exec(text)?.[1] : undefined
    if (key) {
      if (keyPath !== path) log($, `voice: using the OpenAI key from ${path}`)
      keyPath = path
      return key
    }
  }
  return undefined
}

// OpenAI's voice when a key is found; undefined sends the sentence to
// the system voice instead.
async function synthesize($: EngineInterface, text: string, asVoice?: string): Promise<Speech | undefined> {
  const key = await openAiKey($)
  if (!key) {
    log($, 'voice: no OpenAI key found, using the system voice')
    return undefined
  }
  const startedAt = await $.clock.now()
  if (startedAt < openAiPausedUntil) return undefined

  const response = await $.http.fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      voice: asVoice ?? voice,
      input: text,
      instructions: VOICE_STYLE,
      response_format: 'pcm',
      stream_format: 'sse',
    }),
  })
  if (!response.ok) {
    log($, `voice: OpenAI answered ${response.status}: ${response.text.slice(0, 200)}`)
    // A voice this model does not offer: drop to the next one and ask again.
    const fallback = VOICE_ORDER[VOICE_ORDER.indexOf(voice) + 1]
    if (asVoice === undefined && response.status === 400 && /voice/i.test(response.text) && fallback !== undefined) {
      log($, `voice: ${voice} is not available here, using ${fallback}`)
      voice = fallback
      return synthesize($, text)
    }
    if ([401, 402, 403, 429].includes(response.status)) openAiPausedUntil = startedAt + OPENAI_PAUSE_MS
    return undefined
  }

  const chunks = response.text
    .split('\n')
    .filter(line => line.startsWith('data:') && !line.includes('[DONE]'))
    .map(line => {
      try {
        return JSON.parse(line.slice(5)) as { type?: string; audio?: unknown }
      } catch {
        return {}
      }
    })
    .filter(event => event.type === 'speech.audio.delta' && typeof event.audio === 'string')
    .map(event => fromBase64(event.audio as string))
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  if (size === 0) {
    log($, `voice: OpenAI sent no audio: ${response.text.slice(0, 200)}`)
    return undefined
  }

  const whole = new Uint8Array(size)
  chunks.reduce((at, chunk) => (whole.set(chunk, at), at + chunk.length), 0)
  const pcm = trimSilence(whole)
  return {
    base64: toBase64(toWav(pcm)),
    ms: (pcm.length / (SAMPLE_RATE * 2 * PLAYBACK_RATE * VOICE_SPEED)) * 1000,
    voiced: voicedSpans(pcm, VOICE_SPEED),
  }
}

// The stretches where the voice sounds, found by loudness in 20 ms frames: a
// quiet run of PAUSE_MS or more is a pause between phrases.
function voicedSpans(pcm: Uint8Array, speed: number): [number, number][] {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const frame = Math.round(SAMPLE_RATE * 0.02)
  const frames = Math.floor(pcm.length / 2 / frame)
  const energy: number[] = []
  for (let at = 0; at < frames; at++) {
    let sum = 0
    for (let one = at * frame; one < (at + 1) * frame; one++) sum += view.getInt16(one * 2, true) ** 2
    energy.push(Math.sqrt(sum / frame))
  }
  const threshold = Math.max(SILENCE_LEVEL, Math.max(0, ...energy) * 0.08)
  const pauseFrames = Math.round(PAUSE_MS / 20)
  const spans: [number, number][] = []
  let start: number | undefined
  let quiet = 0
  energy.forEach((level, at) => {
    if (level > threshold) {
      start ??= at
      quiet = 0
    } else if (start !== undefined && ++quiet >= pauseFrames) {
      spans.push([start, at - quiet + 1])
      start = undefined
      quiet = 0
    }
  })
  if (start !== undefined) spans.push([start, frames])
  return spans.map(([from, to]) => [(from * 20) / speed, (to * 20) / speed])
}

// Each caption word's moment in the clip, matched in order to the words the
// transcription heard (punctuation and case aside, a few words of slack for
// a word it split or merged); a word it never matched sits between its
// matched neighbours.
function alignWords(caption: string[], heard: { text: string; at: number }[], length: number): number[] {
  const norm = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
  const times: (number | undefined)[] = []
  let next = 0
  for (const word of caption) {
    const target = norm(word)
    let found: number | undefined
    for (let at = next; at < Math.min(heard.length, next + 4); at++) {
      if (norm(heard[at]?.text ?? '') === target) {
        found = at
        break
      }
    }
    times.push(found === undefined ? undefined : heard[found]?.at)
    if (found !== undefined) next = found + 1
  }
  return times.map((time, at) => {
    if (time !== undefined) return time
    let before = at - 1
    while (before >= 0 && times[before] === undefined) before--
    let after = at + 1
    while (after < times.length && times[after] === undefined) after++
    const from = before >= 0 ? (times[before] ?? 0) : 0
    const to = after < times.length ? (times[after] ?? length) : length
    const span = (after < times.length ? after : times.length) - before
    return from + ((to - from) * (at - before)) / Math.max(1, span)
  })
}

// Where in the clip a share of the spoken words is reached, walking only the
// voiced stretches, so pauses hold the highlight in place.
function timeAt(spans: [number, number][], share: number): number {
  const voiced = spans.reduce((sum, [from, to]) => sum + (to - from), 0)
  let left = share * voiced
  for (const [from, to] of spans) {
    if (left <= to - from) return from + left
    left -= to - from
  }
  return spans.at(-1)?.[1] ?? 0
}

// OpenAI pads a take with silence; cut it so the clip's length is the voice's.
function trimSilence(pcm: Uint8Array): Uint8Array {
  const [from, to] = soundBounds(pcm)
  return from === 0 && to === pcm.length ? pcm : fadeEdges(pcm.subarray(from, to))
}

// The byte range of a take that holds its sound, with 40 ms of margin each side.
function soundBounds(pcm: Uint8Array): [number, number] {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const samples = Math.floor(pcm.length / 2)
  const isLoud = (at: number) => Math.abs(view.getInt16(at * 2, true)) > SILENCE_LEVEL
  let first = 0
  while (first < samples && !isLoud(first)) first++
  let last = samples - 1
  while (last > first && !isLoud(last)) last--
  if (first >= last) return [0, pcm.length]
  const pad = Math.round(SAMPLE_RATE * 0.04)
  return [Math.max(0, first - pad) * 2, (Math.min(samples - 1, last + pad) + 1) * 2]
}

// A 10 ms fade in and out on a copy of the clip, so it never starts or stops
// mid-wave, which pops.
function fadeEdges(pcm: Uint8Array): Uint8Array {
  const copy = new Uint8Array(pcm)
  const view = new DataView(copy.buffer)
  const samples = Math.floor(copy.length / 2)
  const fade = Math.min(Math.round(SAMPLE_RATE * 0.01), Math.floor(samples / 2))
  for (let at = 0; at < fade; at++) {
    const gain = at / fade
    view.setInt16(at * 2, Math.round(view.getInt16(at * 2, true) * gain), true)
    const end = samples - 1 - at
    view.setInt16(end * 2, Math.round(view.getInt16(end * 2, true) * gain), true)
  }
  return copy
}

// What it costs this Mac to start a program, which afplay pays before a sound.
async function measureClipLead($: EngineInterface) {
  if (isLeadMeasured) return
  isLeadMeasured = true
  const before = await $.clock.now()
  await $.process.run(['/usr/bin/true']).catch(() => undefined)
  clipLead = Math.max(80, (await $.clock.now()) - before + AFPLAY_START_MS)
  log($, `voice: clips start about ${Math.round(clipLead)}ms after they are handed over`)
}

// Each line's take, asked for once: the next line's is fetched while Bob says
// the current one.
function voiceFor($: EngineInterface, text: string) {
  const known = voiceCache.get(text)
  if (known) return known
  const asked = speakable($, text)
  voiceCache.set(text, asked)
  const oldest = voiceCache.keys().next().value
  if (voiceCache.size > 24 && oldest !== undefined) voiceCache.delete(oldest)
  return asked
}

function log($: EngineInterface, line: string) {
  logLines.push(`${new Date().toISOString().slice(11, 23)} ${line}`)
  logLines.splice(0, Math.max(0, logLines.length - 300))
  void $.fs.write(LOG_PATH, `${logLines.join('\n')}\n`).catch(() => undefined)
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// The system voice at SAY_WPM; resolves once it has finished speaking.
async function say($: EngineInterface, text: string) {
  isSaying = true
  try {
    const result = await $.process.run(['say', '-v', MAC_VOICE, '-r', String(SAY_WPM), '-f', '-'], { stdin: text })
    if (result.exitCode !== 0) log($, `voice: say exited ${result.exitCode}: ${result.stderr.slice(0, 200)}`)
  } catch (error) {
    log($, `voice: say failed: ${reasonOf(error)}`)
  } finally {
    isSaying = false
  }
}

// Plays OpenAI's take through afplay, as the system voice plays through say:
// a clip handed to the engine as bytes can be skipped without a sound.
const clipPath = () => CLIP_PATHS[clipTurn] ?? `${CLIP_DIR}/line-a.wav`

async function saveClip($: EngineInterface, base64: string) {
  try {
    clipTurn = (clipTurn + 1) % CLIP_PATHS.length
    const saved = await $.process.run(['/bin/sh', '-c', 'mkdir -p "$1" && /usr/bin/base64 -D -o "$2"', 'sh', CLIP_DIR, clipPath()], {
      stdin: base64,
    })
    if (saved.exitCode !== 0) throw new Error(saved.stderr.slice(0, 200) || `exit ${saved.exitCode}`)
    return true
  } catch (error) {
    log($, `voice: clip could not be saved: ${reasonOf(error)}`)
    return false
  }
}

async function playSavedClip($: EngineInterface, speed = VOICE_SPEED, path = clipPath()) {
  isClipPlaying = true
  try {
    // Rate processing only when the clip is sped up; at normal speed it adds a
    // start delay of its own.
    const rate = speed === 1 ? [] : ['-r', String(speed), '-q', '1']
    const played = await $.process.run(['/usr/bin/afplay', ...rate, path])
    if (played.exitCode !== 0 && played.exitCode !== 143) log($, `voice: afplay exited ${played.exitCode}`)
  } catch (error) {
    log($, `voice: clip failed: ${reasonOf(error)}`)
  } finally {
    isClipPlaying = false
  }
}

// Stops whatever Bob is saying now.
function hush($: EngineInterface) {
  stopClip?.abort()
  if (isSaying) void $.process.run(['pkill', '-x', 'say']).catch(() => undefined)
  // Always: a line left playing from before a reload stops too.
  stopStream($)
  // Only players: a voice still being fetched (its file path in the helper's
  // arguments) is left to finish into the cache.
  if (isClipPlaying) void $.process.run(['pkill', '-f', `^/usr/bin/afplay ${CLIP_DIR}/`]).catch(() => undefined)
}

// A soft cue from Bob's sounds folder, quiet enough to stay in the background.
// A new clip stops the one playing, so cues stay quiet while Bob speaks.
function cue($: EngineInterface, name: 'think' | 'done' | 'ask' | 'heartbeat' | 'start' | 'end' | 'tap', gain: number) {
  void read($, settings).then(({ isVoiceOn }) => {
    if (!isVoiceOn || isSpeaking) return
    const asset = {
      think: 'sounds/think.wav',
      done: 'sounds/done.wav',
      ask: 'sounds/ask.wav',
      heartbeat: 'sounds/heartbeat.wav',
      start: 'sounds/start.wav',
      tap: 'sounds/tap.wav',
      end: 'sounds/end.wav',
    }[name]
    const stop = new AbortController()
    playingCues.add(stop)
    return $.audio
      .play({ asset }, { signal: stop.signal, gain })
      .catch(error => log($, `sound ${name} failed: ${reasonOf(error)}`))
      .finally(() => playingCues.delete(stop))
  })
}

function toCaptionLines(text: string, sentence: number, isSpoken = false): CaptionLine[] {
  return phraseChunks(text).map(words => (isSpoken ? { words, sentence, spoken: true } : { words, sentence }))
}

// What Bob says to close a reply: a question or a request for you opens with
// its intro so you know without looking; anything else is the summary itself.
function closingLine(gist: string, choice: Choice | null) {
  if (choice !== null) return `${QUESTION_INTRO} ${choice.ask}`
  const { tag, text } = tagOf(gist)
  if (tag === 'QUESTION FOR YOU') return `${QUESTION_INTRO} ${text}`
  if (tag === 'NEEDS YOU') return `${ATTENTION_INTRO} ${text}`
  return gist
}

// How Bob closes a reply, sentence by sentence: what the reply says, then the
// question or request, which gets the ding. For plain news the explanation is
// enough on its own.
function closingSentences(gist: string, choice: Choice | null, say: string, notes: string[] = []): string[] {
  const last = closingLine(gist, choice)
  // A one-line question ("Hi, how can I help you today?") is said as written:
  // "Question for you." only leads a question that follows an explanation.
  if (say === '' && choice === null && tagOf(gist).tag === 'QUESTION FOR YOU') return [...notes, tagOf(gist).text]
  if (say === '') return needsYou(last) ? [...notes, last] : [last, ...notes]
  return needsYou(last) ? [say, ...notes, last] : [say, ...notes]
}

const needsYou = (text: string) => text.startsWith(QUESTION_INTRO) || text.startsWith(ATTENTION_INTRO)

// Text up to its last finished sentence: a summary cut short mid-sentence is
// spoken only as far as it makes sense.
function wholeSentences(text: string): string {
  const trimmed = text.trim()
  if (trimmed === '' || /[.!?]["')\]]*$/.test(trimmed)) return trimmed
  const end = Math.max(trimmed.lastIndexOf('. '), trimmed.lastIndexOf('! '), trimmed.lastIndexOf('? '))
  // One unfinished sentence is still what the reply says: keep it, closed.
  return end > 0 ? trimmed.slice(0, end + 1) : `${trimmed}.`
}

// One short spoken line for the whole reply, by a small fast model; undefined
// when it has none to give.
async function summarize(
  $: EngineInterface,
  answer: string,
  alreadySaid = '',
): Promise<{ gist: string; say: string; points: string[]; options: string[] } | undefined> {
  // The listener just heard the reply's opening line: the Say line goes on
  // from it instead of saying it again.
  const heard = alreadySaid.trim() === '' ? '' : `\n\n---\nAlready said out loud, just now: "${alreadySaid.trim()}". The Say line must not repeat it: pick up from there with what is new.`
  const result = await $.model.complete({
    model: GIST_MODEL,
    system: GIST_SYSTEM,
    prompt: `${answer.slice(0, 6000)}${heard}`,
    maxTokens: 500,
    timeoutMs: 8000,
  })
  if (!result.isAnswered) {
    log($, `gist: no line (${result.reason})`)
    return undefined
  }
  const lines = result.text
    .replace(/[*_`#]/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  const isSay = (line: string) => /^say:/i.test(line)
  const gist = lines.find(line => !line.startsWith('-') && !line.startsWith('>') && !isSay(line))
  if (gist === undefined) return undefined
  const say = wholeSentences((lines.find(isSay) ?? '').replace(/^say:\s*/i, ''))
  const points = lines
    .filter(line => line.startsWith('-'))
    .map(line => line.replace(/^-\s*/, ''))
    .slice(0, 3)
  const options = lines
    .filter(line => line.startsWith('>'))
    .map(line => line.replace(/^>\s*/, ''))
    .filter(line => line !== '')
    .slice(0, 4)
  return { gist, say, points, options }
}

// Ends the reply: its last message is swapped for Bob's one-line gist, which
// is what he says out loud; the full answer waits in the card.
async function finish($: EngineInterface, id: number, answer: string, isAborted: boolean) {
  try {
    await finishReply($, id, answer, isAborted)
  } finally {
    if (finishingId === id) finishingId = undefined
  }
}

// A short reply is said as written, with no summary to wait for: its last
// sentence, when a question, becomes the question; the rest is the line said.
function shortSummary(answer: string) {
  const plain = toPlain(answer).replace(/\s+/g, ' ').trim()
  if (plain === '' || plain.split(' ').length > SHORT_REPLY_WORDS) return undefined
  const sentences = plain.split(/(?<=[.!?])\s+/)
  const last = sentences.at(-1) ?? ''
  if (last.endsWith('?')) {
    return { gist: `Question: ${last}`, say: sentences.slice(0, -1).join(' '), points: [], options: [] }
  }
  return { gist: `Done: ${plain}`, say: plain, points: [], options: [] }
}

async function finishReply($: EngineInterface, id: number, answer: string, isAborted: boolean) {
  const quick = isAborted ? undefined : shortSummary(answer)
  const said = await read($, reply).then(now => {
    if (now === null) return ''
    const lastStart = now.blocks.length > 1 ? (now.blocks.at(-2)?.end ?? 0) : 0
    const end = now.word >= 0 ? sentenceAt(now.lines, now.line).end : now.line
    return now.lines.slice(lastStart, end).flatMap(one => one.words).join(' ')
  })
  const summary = quick ?? (isAborted || answer.trim() === '' ? undefined : await summarize($, answer, said).catch(error => {
    log($, `gist failed: ${reasonOf(error)}`)
    return undefined
  }))
  const gist = summary?.gist
  if (gist) log($, `gist: ${gist} (+${summary?.options.length ?? 0} options)`)
  // A question asked in plain words, with named options, gets them as buttons
  // under it once Bob is done talking; a click sends that answer.
  const asked: Choice | null =
    gist !== undefined && tagOf(gist).tag === 'QUESTION FOR YOU' && (summary?.options.length ?? 0) >= 2
      ? { ask: tagOf(gist).text, options: (summary?.options ?? []).map(option => ({ label: option, text: option })) }
      : null
  // Bob fetches the summary's voice while he finishes the line he is on, so
  // it follows without a gap. With the voice off, the finish sound plays now.
  const notes = notesOf(await read($, reply), answer)
  if (gist !== undefined) {
    const { isVoiceOn } = await read($, settings)
    if (isVoiceOn) {
      const before = await read($, reply)
      for (const sentence of closingSentences(gist, before?.choice ?? asked, summary?.say ?? '', notes)) {
        void voiceFor($, sentence.split(/\s+/).join(' '))
      }
    }
  }

  await update($, reply, now => {
    if (now === null || now.id !== id) return now
    if (gist === undefined) return { ...now, isWorking: false }

    // Earlier messages' lines are all said, and a line being spoken now
    // finishes; the last message's unsaid opener gives way to the explanation,
    // which says what that message says.
    const lastStart = now.blocks.length > 1 ? (now.blocks.at(-2)?.end ?? 0) : 0
    // A silent caption on screen (one of the last message's own lines) gives
    // way at once: it costs nothing to drop, and the spoken version of the
    // same reply follows straight away instead of after it.
    const showing = now.lines[now.line]
    // A line the voice is saying right now is never silent, so it finishes.
    const isSilentShowing =
      now.line >= lastStart && showing !== undefined && showing.spoken !== true && !isSpeaking && !isStreaming
    const keep = Math.min(
      now.lines.length,
      Math.max(
        lastStart,
        // Lines before the pointer were already said: they stay.
        now.word >= 0 && !isSilentShowing ? sentenceAt(now.lines, now.line).end : now.line,
      ),
    )
    const first = (now.lines[keep - 1]?.sentence ?? -1) + 1
    const choice = now.choice ?? asked
    // A sentence of the reply already said as it arrived is not said again.
    const said = now.lines
      .slice(lastStart, keep)
      .flatMap(one => one.words)
      .join(' ')
      .toLowerCase()
    const closing = closingSentences(gist, choice, summary?.say ?? '', notes)
      .filter(text => !said.includes(text.toLowerCase()))
      .flatMap((text, at) => toCaptionLines(text, first + at, true))
    const lines = [...now.lines.slice(0, keep), ...closing]
    const blocks = now.blocks.map((block, at) =>
      at === now.blocks.length - 1 ? { ...block, end: lines.length } : { ...block, end: Math.min(block.end, keep) },
    )
    return {
      ...now,
      lines,
      blocks,
      gist,
      say: summary?.say ?? '',
      choice,
      points: summary?.points ?? [],
      pointAt: 0,
      isWorking: false,
      line: Math.min(now.line, keep),
    }
  })
}

// OpenAI's take on a line, given up on after OPENAI_WAIT_MS and asked once
// more, so a stuck request never leaves Bob silent or swaps his voice for long.
// The live voice first (OpenAI's Realtime model, as in ChatGPT voice mode),
// then the speech model, so a hiccup in one never leaves Bob silent.
// The live voice is asked first; if it has not answered within BACKUP_AFTER_MS
// the speech model is asked too, and the first take back wins. Past
// VOICE_DEADLINE_MS the line goes to the Mac voice, so silence never runs long.
async function speakable($: EngineInterface, text: string): Promise<Speech | undefined> {
  // One voice only, the one picked (live or normal). No second voice is asked
  // in parallel, so a line is never paid twice and never heard in a different
  // voice; if it fails or is too slow, the line shows silently (a live take
  // still being made lands in the helper's cache for next time).
  const got = await Promise.race([
    (await engineOf($)) === 'live' ? synthesizeLive($, text) : synthesize($, text),
    wait($, VOICE_DEADLINE_MS).then(() => 'timeout' as const),
  ])
  if (got === 'timeout') {
    log($, `voice: no take within ${VOICE_DEADLINE_MS}ms`)
    return undefined
  }
  return got
}

// A line in the live voice, from the helper beside Bob's key file: it opens
// OpenAI's Realtime connection, which a mod cannot open itself.
async function synthesizeLive($: EngineInterface, text: string, asVoice?: string): Promise<Speech | undefined> {
  // No key: the line goes to the system voice, never to OpenAI.
  if ((await openAiKey($)) === undefined) return undefined
  try {
    const { voiceStyle } = await read($, settings)
    const style = typeof voiceStyle === 'string' && VOICE_STYLES.includes(voiceStyle) ? voiceStyle : 'narrator'
    // The helper writes the take straight to this file; only a small note
    // (length, word times, voiced stretches) comes back, so no output limit
    // can cut a long line short.
    liveTurn += 1
    const path = `${CLIP_DIR}/live-${Date.now()}-${liveTurn}.wav`
    await $.process.run(['/bin/mkdir', '-p', CLIP_DIR])
    const result = await $.process.run([NODE_PATH, 'node', LIVE_HELPER($), asVoice ?? voice, LIVE_MODEL, style, path], {
      stdin: text,
    })
    if (result.exitCode !== 0) {
      log($, `voice: live voice failed: ${result.stderr.trim().slice(0, 200) || `exit ${result.exitCode}`}`)
      return undefined
    }
    const note = JSON.parse(result.stdout.trim()) as {
      ms?: unknown
      words?: { word?: unknown; at?: unknown }[]
      voiced?: unknown
    }
    if (typeof note.ms !== 'number' || note.ms <= 0) return undefined
    if (!hasUsedLive) log($, `voice: speaking with the live voice (${LIVE_MODEL}, ${voice})`)
    hasUsedLive = true
    const heard = (note.words ?? [])
      .filter(one => typeof one.word === 'string' && typeof one.at === 'number')
      .map(one => ({ text: String(one.word), at: Number(one.at) }))
    if (heard.length === 0) log($, 'voice: no word times for this line, timing it from its pauses')
    const voiced = Array.isArray(note.voiced)
      ? (note.voiced as unknown[]).filter(
          (span): span is [number, number] =>
            Array.isArray(span) && typeof span[0] === 'number' && typeof span[1] === 'number',
        )
      : []
    return { path, ms: note.ms, speed: VOICE_SPEED, voiced, heard }
  } catch (error) {
    log($, `voice: live voice could not run: ${reasonOf(error)}`)
    return undefined
  }
}

// The same short line in each candidate voice, named in a popup as it plays.
async function playSamples($: EngineInterface) {
  const engine = await engineOf($)
  if (engine === 'mac') {
    $.ui.toast('These are OpenAI voices: pick /bob normal or /bob live first.')
    return
  }
  for (const name of SAMPLE_VOICES) {
    const line = `Hi, I'm Claude, in the ${name} voice. This is how I would sound.`
    const speech =
      (engine === 'live' ? await synthesizeLive($, line, name) : undefined) ??
      (await synthesize($, line, name).catch(() => undefined))
    const path = speech?.path ?? (speech?.base64 !== undefined && (await saveClip($, speech.base64)) ? clipPath() : undefined)
    if (speech === undefined || path === undefined) {
      $.ui.toast(`${name}: no sample (see the captions log)`)
      continue
    }
    $.ui.toast(`Now playing: ${name}`, { timeoutMs: Math.round(speech.ms) + 800 })
    await playSavedClip($, speech.speed, path)
    await wait($, 600)
  }
}

function wait($: EngineInterface, ms: number) {
  return new Promise<void>(resolve => {
    $.clock.after(ms, resolve)
  })
}

// Highlights one word; false once the reply moved on without it (a skip, a
// new prompt).
async function highlight($: EngineInterface, id: number, spoken: Spoken) {
  const now = await update($, reply, current =>
    current !== null &&
    current.id === id &&
    current.line <= spoken.line &&
    current.lines[spoken.line]?.words[spoken.word] === spoken.text
      ? { ...current, line: spoken.line, word: spoken.word }
      : current,
  )
  return (
    now !== null &&
    now.id === id &&
    now.line === spoken.line &&
    now.word === spoken.word &&
    now.lines[spoken.line]?.words[spoken.word] === spoken.text
  )
}

// Says the reply a sentence at a time and walks the highlight over its words
// in step with the voice; the next sentence's audio is fetched meanwhile.
async function play($: EngineInterface) {
  if (isPlaying) return
  isPlaying = true

  try {
    for (;;) {
      const current = await read($, reply)
      if (current === null || current.line >= current.lines.length) break
      // The reply just ended and its summary is on the way: wait for it rather
      // than start the last message's opener, which the summary replaces.
      if (finishingId === current.id && current.word < 0) {
        await wait($, 200)
        continue
      }
      const sentence = sentenceAt(current.lines, current.line)
      taken = { id: current.id, end: sentence.end }
      // Every line is said: each message's headline as it arrives, then the
      // summary and any question that close the reply.
      const isFinal = sentence.end === current.lines.length && !current.isWorking
      const isVoiceOn = (await read($, settings)).isVoiceOn === true
      // Another chat speaking holds the voice: this one waits its turn.
      if (isVoiceOn && !(await takeVoiceTurn($, current.id, current.line))) continue

      // With OpenAI reachable, the line is streamed: the voice starts as soon
      // as the first sound arrives, and the words light up with it.
      if (isVoiceOn && (await engineOf($)) === 'live' && (await findKey($)) !== undefined) {
        const isForYou =
          needsYou(sentence.text) ||
          (current.lines[current.line]?.spoken === true && isFinal && sentence.text.trim().endsWith('?'))
        log($, `say #${current.line} (live): ${sentence.text}`)
        // One voice at a time: a line still playing out finishes first.
        await untilOldVoiceEnds($)
        const isFreshStart = (await $.clock.now()) - lastSpokeAt > RUN_GAP_MS
        const opening = isForYou
          ? ({ name: 'ask', leadMs: DING_GAP_MS } as const)
          : isFreshStart
          ? ({ name: 'start', leadMs: TONE_GAP_MS } as const)
          : undefined
        const outcome = await streamLine($, current.id, sentence, opening)
        if (outcome === 'cut') {
          log($, `line #${current.line} cut: the reply moved on`)
          continue
        }
        if (outcome === 'failed') await showSilently($, current.id, sentence)
        await wait($, LINE_HOLD_MS)
        if (outcome === 'done') await closingCue($, current.id, current.line, isFinal, isForYou)
        await moveOn($, current.id, current.line, sentence)
        continue
      }

      let speech: Speech | undefined
      if (isVoiceOn) {
        await measureClipLead($)
        speech = await voiceFor($, sentence.text)
        // Only the very next line is fetched ahead, so it is ready in time;
        // nothing further out, which a summary could still replace unheard.
        const upcoming = sentenceAt(current.lines, sentence.end)
        if (upcoming.words.length > 0) void voiceFor($, upcoming.text)
      }
      // The reply may have changed while the voice was fetched (the summary
      // replaces an unsaid opener): say only what is still there.
      if (!(await isStillAt($, current.id, current.line, sentence.text))) continue

      const total = sentence.words.reduce((sum, one) => sum + weightOf(one.text), 0)
      // The clip is written out before the clock starts, so the captions start
      // with the voice and not with the file.
      if (speech !== undefined && speech.path === undefined) {
        if (speech.base64 === undefined || !(await saveClip($, speech.base64))) speech = undefined
      }
      // This line's own file: a skip stops this clip alone, never the one
      // before it that may still be finishing its last words.
      const linePath = speech?.path ?? clipPath()
      // The Mac's own voice is a different person: with OpenAI reachable, a
      // line OpenAI could not voice in time shows as a silent caption instead.
      const hasOpenAi = isVoiceOn && speech === undefined && (await openAiKey($)) !== undefined
      if (hasOpenAi) log($, `voice: no take for #${current.line} in time, showing it silently`)
      // Whether this line is heard at all: a silent caption runs on its own clock.
      const speaks = isVoiceOn && !hasOpenAi
      const isSystem = speaks && speech === undefined
      const planned = speech?.ms ?? total * (isSystem ? SAY_MS_PER_WEIGHT * pace : MS_PER_WEIGHT)
      const ms = planned
      const lead = isSystem ? SAY_START_MS : speech !== undefined ? clipLead : 0
      const stop = new AbortController()
      stopClip = stop
      log($, `say #${current.line} (${speech ? 'openai' : speaks ? 'system' : 'silent'}): ${sentence.text}`)
      // The ding marks a question for you: one with its intro, or the bare
      // question a reply ends on.
      const isForYou =
        needsYou(sentence.text) ||
        (current.lines[current.line]?.spoken === true && sentence.end === current.lines.length && sentence.text.trim().endsWith('?'))
      if (speaks) {
        // The ding always marks a question; the soft start tone only opens a
        // stretch of talking, never sits between two lines said back to back.
        const isFreshStart = (await $.clock.now()) - lastSpokeAt > RUN_GAP_MS
        if (isForYou) {
          cue($, 'ask', 0.7)
          await wait($, DING_GAP_MS)
        } else if (isFreshStart) {
          cue($, 'start', 0.7)
          await wait($, TONE_GAP_MS)
        }
      }
      isSpeaking = speaks === true
      let hasEnded = false
      const sound: Promise<unknown> = !speaks
        ? Promise.resolve()
        : speech !== undefined
          ? playSavedClip($, speech.speed, linePath)
          : say($, sentence.text)
      const ended = sound
        .then(() => $.clock.now())
        .finally(() => {
          isSpeaking = false
          hasEnded = true
        })

      const startedAt = await $.clock.now()
      let said = 0
      let isCut = false
      // Each word's moment: when it is actually spoken, from the clip's word
      // times; else from its voiced stretches; else spread over the line.
      const heardAt =
        speech?.heard !== undefined && speech.heard.length > 0
          ? alignWords(
              sentence.words.map(one => one.text),
              speech.heard,
              ms,
            )
          : undefined
      // The panel repaints a beat after each highlight is set, so every word
      // is lit that much early, plus the user's own nudge (/bob sync). The
      // first word lights as the voice starts, so the line is up with it.
      const { syncMs } = await read($, settings)
      const shift = (typeof syncMs === 'number' ? syncMs : 0) - (speaks ? REPAINT_MS : 0)
      for (const [index, spoken] of sentence.words.entries()) {
        const heard =
          heardAt !== undefined
            ? (heardAt[index] ?? 0)
            : speech?.voiced !== undefined && speech.voiced.length > 0
              ? timeAt(speech.voiced, said / total)
              : (said / total) * ms
        const at = index === 0 ? Math.min(heard, 0) + shift : heard + shift
        const delay = startedAt + lead + at - (await $.clock.now())
        if (delay > 0) await wait($, delay)
        // The voice is the clock: once it stops, so does the caption.
        if (speaks && hasEnded) break
        if (!(await highlight($, current.id, spoken))) {
          isCut = true
          break
        }
        said += weightOf(spoken.text)
      }

      if (isCut) {
        log($, `line #${current.line} cut: the reply moved on`)
        if (speech !== undefined) void $.process.run(['pkill', '-f', `^/usr/bin/afplay ${linePath}`]).catch(() => undefined)
        else if (speaks) hush($)
        continue
      }
      // A clip's audio ends at a known time, but afplay lingers about a second
      // after it before quitting. So once the audio is over (with a margin),
      // its player is closed, and only then does the next line start: never
      // two voices at once, and no long dead air. Silent lines share the clock.
      const voiceEnd = startedAt + lead + ms + (speech !== undefined ? CLIP_TAIL_MS : 0)
      if (!speaks || speech !== undefined) {
        const rest = voiceEnd - (await $.clock.now())
        if (rest > 0) await Promise.race([wait($, rest), ended])
        if (speech !== undefined && !hasEnded) {
          await $.process.run(['pkill', '-f', `^/usr/bin/afplay ${linePath}`]).catch(() => undefined)
        }
        await ended
        isSpeaking = false
      }
      const endedAt = speech !== undefined ? Math.min(await $.clock.now(), voiceEnd) : await ended
      const spokeMs = endedAt - startedAt - lead
      if (speech !== undefined) {
        // Only logged: the overrun also holds the player closing after the last
        // sound, so it says nothing about when the voice started.
        log($, `clip took ${Math.round(spokeMs)}ms for ${Math.round(planned)}ms of audio`)
      }
      if (isSystem) {
        pace = Math.min(2.5, Math.max(0.5, pace * (0.5 + (0.5 * spokeMs) / ms)))
        void $.store.set(PACE_KEY, pace)
        log($, `system voice took ${Math.round(spokeMs)}ms for ${Math.round(ms)}ms planned, pace ${pace.toFixed(2)}`)
      }
      await wait($, LINE_HOLD_MS)
      if (speaks) {
        // After Bob's last word the finish sound says he is done (or that Claude
        // needs you); if Claude is still at it, a little typing says so instead.
        // Nothing plays if Claude is about to talk again: only once the last
        // queued line is said.
        const after = await read($, reply)
        lastSpokeAt = await $.clock.now()
        const isMoreToSay = after !== null && sentenceAt(after.lines, current.line).end < after.lines.length
        if (after !== null && after.id === current.id && !isMoreToSay) {
          if (isFinal && !isForYou) cue($, 'done', 0.4)
          else if (after.isWorking) cue($, 'heartbeat', 0.8)
        }
      }
      // Move past the sentence only if it is still the one in place; when the
      // summary replaced it, the line already points at the new text.
      await update($, reply, now =>
        now !== null &&
        now.id === current.id &&
        now.line < sentence.end &&
        sentenceAt(now.lines, current.line).text === sentence.text
          ? { ...now, line: sentence.end, word: -1 }
          : now,
      )
    }
  } catch (error) {
    log($, `play stopped: ${reasonOf(error)}`)
  } finally {
    releaseVoiceTurn($)
    isPlaying = false
    taken = undefined
  }

  // Text that landed while the loop was finishing starts it again.
  const left = await read($, reply)
  if (left !== null && left.line < left.lines.length) $.clock.after(0, () => void play($))
}

type Kit = ReturnType<EngineInterface['ui']['resolve']>

const GIST_LABEL = /^(Question|Needs you|Done|Update):\s*/i

// The gist's label as a tag: red when Claude needs you, orange when it is done.
function tagOf(gist: string) {
  const label = GIST_LABEL.exec(gist)?.[1]?.toLowerCase()
  const text = gist.replace(GIST_LABEL, '')
  if (label === 'question') return { tag: 'QUESTION FOR YOU', isAsk: true, text }
  if (label === 'needs you') return { tag: 'NEEDS YOU', isAsk: true, text }
  if (label === 'done') return { tag: 'DONE', isAsk: false, text }
  return { tag: label === 'update' ? 'UPDATE' : '', isAsk: false, text }
}

// What you sent, then Bob's line and the full answer once he is done: in the
// band, or in the side panel when it is open there.
type CardActions = {
  onHide: () => void
  onFull: () => void
  onReplay: () => void
  onPoint: (at: number) => void
  onChoose: (text: string) => void
  onCopy: (text: string, surface: CopySurface) => void
  onOpen: (target: string) => void
  onRetry: () => void
}

type CopySurface = Parameters<EngineInterface['ui']['copy']>[0]['surface']

// The finished reply at a glance: Bob's line big, your message as one small
// line, the key points one at a time, and what you can do with it.
function card(ui: Kit, current: Reply, actions: CardActions, mode: 'band' | 'brief' | 'pane' = 'band') {
  const { Box, Button, Text } = ui
  const answer = moodOf(current) === 'idle' ? toPlain(current.blocks.map(one => one.text).join('\n\n')) : ''
  if (current.prompt === '' && answer === '') return null
  const paragraphs = answer
    .split(/\n+/)
    .map(one => one.trim())
    .filter(one => one !== '')
  const choice = current.choice ?? null
  const commands = commandsOf(current.blocks.map(one => one.text).join('\n\n'))
  const { tag, isAsk, text } = choice !== null ? tagOf(`Question: ${choice.ask}`) : tagOf(current.gist)
  const limit = mode === 'pane' ? MAX_PROMPT : BAND_PROMPT
  const prompt = current.prompt.length > limit ? `${current.prompt.slice(0, limit).trimEnd()}…` : current.prompt
  const you = prompt !== '' && mode !== 'brief' && (
    <Box flexDirection="row" gap={1}>
      <Text size="footnote" dimColor>
        you
      </Text>
      <Text size="footnote">{prompt}</Text>
    </Box>
  )

  if (answer === '' && !current.failure) return you || null

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" alignItems="center" gap={2}>
        <Box paddingX={1} backgroundColor={isAsk ? HIGHLIGHT : undefined}>
          <Text size="caption" weight="bold" color={isAsk ? '#FFFFFF' : CLAUDE_ORANGE}>
            {tag !== '' ? tag : 'DONE'}
          </Text>
        </Box>
        <Text size="caption" tabular dimColor>
          {clockOf(current.seconds)}
        </Text>
      </Box>
      {isAsk && current.say && mode !== 'brief' && <Text size="body">{current.say}</Text>}
      <Text size="heading" weight="bold">
        {text !== '' ? text : (paragraphs[0] ?? '')}
      </Text>
      {!isAsk && current.say && mode !== 'brief' && <Text size="body">{current.say}</Text>}
      {choice !== null && choice.options.length > 0 && mode !== 'brief' && (
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap={1} marginTop={1}>
          {choice.options.map((option, at) => {
            const isPicked = Boolean(current.picked) && current.picked === option.text
            const isOther = Boolean(current.picked) && !isPicked
            return (
              // The app's own white button, so it stands out; its number key picks it too.
              <Button
                key={`choice${at}`}
                variant="primary"
                dimColor={isOther}
                hotkey={String(at + 1)}
                label={`${isPicked ? '✓ ' : ''}${option.label}`}
                onPress={() => actions.onChoose(option.text)}
              />
            )
          })}
        </Box>
      )}
      {current.failure && (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Text size="footnote" weight="medium" color={FAILURE_RED}>
            {current.failure}
          </Text>
          {current.prompt !== '' && mode !== 'brief' && (
            <Button key="retry" variant="secondary" label="Retry" onPress={() => actions.onRetry()} />
          )}
        </Box>
      )}
      {mode !== 'brief' &&
        (current.opened ?? []).map((one, at) => (
          <Box key={`opened${at}`} flexDirection="row" alignItems="center" gap={1}>
            {one.target !== '' && (
              <Button key={`openbutton${at}`} variant="primary" label="Open" onPress={() => actions.onOpen(one.target)} />
            )}
            <Text size="footnote" dimColor>
              {one.name}
            </Text>
          </Box>
        ))}
      {mode !== 'brief' &&
        commands.map((command, at) => {
          const isCopied = current.copied === command
          return (
            <Box key={`copy${at}`} flexDirection="row" alignItems="center" gap={1}>
              <Button
                key={`copybutton${at}`}
                variant="primary"
                label={isCopied ? '✓ Copied' : 'Copy'}
                onPress={press => actions.onCopy(command, press.surface)}
              />
              <Text size="footnote" dimColor>
                {command.split('\n')[0]}
                {command.includes('\n') ? ' …' : ''}
              </Text>
            </Box>
          )
        })}
      {you}
      {mode === 'pane' &&
        paragraphs.map((paragraph, at) => (
          <Text key={`p${at}`} size="body" dimColor>
            {paragraph}
          </Text>
        ))}
    </Box>
  )
}

function cardActions($: EngineInterface): CardActions {
  return {
    onHide: () => void showAll($),
    onFull: () => void toggleFull($),
    onReplay: () => void replay($),
    onPoint: at => void update($, reply, now => (now === null ? now : { ...now, pointAt: at })),
    // Answers as the app's own button would: the same words, sent as you.
    onChoose: text => void choose($, text),
    onCopy: (text, surface) => void copyCommand($, text, surface),
    onOpen: target => void openTarget($, target),
    onRetry: () => void retry($),
  }
}

// An Open chip: the file in its app, the page in the browser.
async function openTarget($: EngineInterface, target: string) {
  log($, `open: ${target}`)
  cue($, 'tap', 0.8)
  await $.process.run(['open', target]).catch(error => log($, `open failed: ${reasonOf(error)}`))
}

// Retry: your last message, sent again.
async function retry($: EngineInterface) {
  const now = await read($, reply)
  if (now === null || now.prompt === '') return
  log($, `retry: ${now.prompt}`)
  cue($, 'tap', 0.8)
  const askedAt = await $.clock.now()
  const failure = now.failure
  // After you press stop, the app lets no plugin restart Claude until you
  // type: your message goes straight in the box, and Enter sends it.
  if (failure === 'Stopped.') {
    await $.prompt.fill({ text: now.prompt, mode: 'replace' }).catch(() => undefined)
    await update($, reply, one => (one === null ? one : { ...one, failure: 'Stopped. Press Enter to retry.' }))
    return
  }
  void sendAnswer($, now.prompt)
  // After a stop the app may hold the message back: then it goes in the
  // message box, and the panel says so instead of sitting on Cooking.
  $.clock.after(RETRY_CHECK_MS, () => {
    if (lastTurnStartAt >= askedAt) return
    log($, 'retry: the app held it back; put it in the message box')
    pendingAnswer = undefined
    void $.prompt.fill({ text: now.prompt, mode: 'replace' }).catch(() => undefined)
    void update($, reply, one =>
      one === null
        ? one
        : { ...one, isWorking: false, failure: `${failure ?? 'Stopped.'} Press Enter to retry.` },
    )
  })
}

// What Claude is stuck on, as the panel asks it; undefined when the panel
// can't answer it (the app's own dialog then stays the only way).
function panelAskOf(tool: string, input: Record<string, unknown>, key: string): PanelAsk | undefined {
  const base = { key, at: 0, picks: [], answers: [] }
  if (tool === 'AskUserQuestion') {
    const asked = Array.isArray(input.questions) ? (input.questions as Record<string, unknown>[]) : []
    const questions = asked
      .map(one => ({
        question: String(one.question ?? ''),
        options: (Array.isArray(one.options) ? (one.options as Record<string, unknown>[]) : [])
          .map(option => String(option.label ?? ''))
          .filter(label => label !== ''),
        isMulti: one.multiSelect === true,
      }))
      .filter(one => one.question !== '' && one.options.length > 0)
    return questions.length > 0 ? { ...base, kind: 'questions', questions } : undefined
  }
  if (tool === 'ExitPlanMode') return { ...base, kind: 'plan', questions: [] }
  return { ...base, kind: 'permission', questions: [] }
}

// The plan in one line: its first line of text, cut short.
function planLine(input: Record<string, unknown>): string {
  const first = String(input.plan ?? '')
    .split('\n')
    .map(one => one.replace(/^[#>*\-\s]+/, '').replace(/[*_`]/g, '').trim())
    .find(one => one !== '')
  if (first === undefined) return ''
  return first.length > 90 ? `${first.slice(0, 89).trimEnd()}…` : first
}

// Waits for your answer in the panel, ten minutes at most. The wait is a
// process, so the hook's own time budget doesn't run out meanwhile.
async function awaitPanelAnswer($: EngineInterface, key: string, signal?: AbortSignal): Promise<string | undefined> {
  const file = `${CLIP_DIR}/answer-${key}`
  const stop = () => void $.fs.write(file, '').catch(() => undefined)
  signal?.addEventListener('abort', stop)
  try {
    const result = await $.process.run(
      ['/bin/sh', '-c', `mkdir -p '${CLIP_DIR}'; f='${file}'; while [ ! -e "$f" ]; do sleep 0.1; done; cat "$f"; rm -f "$f"`],
      { timeoutMs: ANSWER_WAIT_MS },
    )
    const text = result.stdout.trim()
    return text === '' ? undefined : text
  } catch (error) {
    log($, `panel answer: none (${reasonOf(error)})`)
    return undefined
  } finally {
    signal?.removeEventListener('abort', stop)
  }
}

// A button under what Claude is stuck on: the answer goes to the waiting hook.
async function answerAsk($: EngineInterface, value: string) {
  const now = await read($, reply)
  const ask = now?.ask
  if (now === null || ask === undefined || ask === null) return
  cue($, 'tap', 0.8)
  if (ask.kind !== 'questions') {
    log($, `panel answer: ${value}`)
    await update($, reply, one => (one === null ? one : { ...one, ask: null, waiting: '', waitingTag: undefined }))
    await $.fs.write(`${CLIP_DIR}/answer-${ask.key}`, value)
    return
  }
  const question = ask.questions[ask.at]
  if (question === undefined) return
  // A multiple-choice option toggles; Send (value '') hands in the picks.
  if (question.isMulti && value !== '') {
    const picks = ask.picks.includes(value) ? ask.picks.filter(one => one !== value) : [...ask.picks, value]
    await update($, reply, one => (one === null || !one.ask ? one : { ...one, ask: { ...one.ask, picks } }))
    // Sends itself once you stop clicking, if nothing changed meanwhile.
    $.clock.after(MULTI_SEND_MS, () => {
      void read($, reply).then(later => {
        const still = later?.ask
        if (!still || still.key !== ask.key || still.at !== ask.at || still.picks.join('\n') !== picks.join('\n')) return
        if (picks.length > 0) void answerAsk($, '')
      })
    })
    return
  }
  const answer = question.isMulti ? ask.picks.join(', ') : value
  if (question.isMulti && answer === '') return
  const answers = [...ask.answers, answer]
  const following = ask.questions[ask.at + 1]
  log($, `panel answer ${ask.at + 1}/${ask.questions.length}: ${answer}`)
  if (following !== undefined) {
    // The next question, said like the first.
    await update($, reply, one =>
      one === null || !one.ask
        ? one
        : {
            ...one,
            ask: { ...one.ask, at: one.ask.at + 1, picks: [], answers },
            waiting: following.question,
            lines: [
              ...one.lines,
              ...toCaptionLines(`${QUESTION_INTRO} ${following.question}`, (one.lines.at(-1)?.sentence ?? -1) + 1, true),
            ],
          },
    )
    $.clock.after(0, () => void play($))
    return
  }
  await update($, reply, one => (one === null ? one : { ...one, ask: null, waiting: '', waitingTag: undefined }))
  await $.fs.write(`${CLIP_DIR}/answer-${ask.key}`, JSON.stringify(answers))
}

// The panel's answer, as the app's dialog would have given it.
function decisionOf(ask: PanelAsk, input: Record<string, unknown>, answer: string) {
  if (ask.kind === 'questions') {
    let answers: string[] = []
    try {
      answers = JSON.parse(answer) as string[]
    } catch {}
    return {
      behavior: 'allow' as const,
      updatedInput: { ...input, answers: Object.fromEntries(ask.questions.map((one, at) => [one.question, answers[at] ?? ''])) },
    }
  }
  if (answer === 'allow') return { behavior: 'allow' as const }
  return {
    behavior: 'deny' as const,
    message:
      ask.kind === 'plan'
        ? 'The user chose Keep planning: keep working on the plan with them before starting.'
        : 'The user denied this from the captions panel.',
  }
}

// The shared voice lock: true once this chat may speak (or the lock can't be
// checked), false if the reply moved on while it waited for the other chat.
const LOCK_SCRIPT = `d='${VOICE_LOCK}'; mkdir -p "$(dirname "$d")"
if mkdir "$d" 2>/dev/null; then echo "$1" > "$d/owner"; exit 0; fi
if [ "$(cat "$d/owner" 2>/dev/null)" = "$1" ]; then touch "$d"; exit 0; fi
if [ $(( $(date +%s) - $(stat -f %m "$d" 2>/dev/null || echo 0) )) -gt ${VOICE_LOCK_STALE_S} ]; then
  rm -rf "$d"; mkdir "$d" 2>/dev/null && echo "$1" > "$d/owner" && exit 0
fi
exit 1`

async function takeVoiceTurn($: EngineInterface, id: number, line: number): Promise<boolean> {
  const me = await read($, owner)
  for (let waited = 0; ; waited += 300) {
    const got = await $.process.run(['/bin/sh', '-c', LOCK_SCRIPT, 'voice-lock', me]).catch(() => undefined)
    if (got === undefined || got.exitCode === 0) return true
    if (waited === 0) log($, 'another chat is speaking: waiting for its turn')
    await wait($, 300)
    const now = await read($, reply)
    if (now === null || now.id !== id || now.line !== line) return false
  }
}

function releaseVoiceTurn($: EngineInterface) {
  void read($, owner).then(me =>
    $.process
      .run(['/bin/sh', '-c', `[ "$(cat '${VOICE_LOCK}/owner' 2>/dev/null)" = "$1" ] && rm -rf '${VOICE_LOCK}'; exit 0`, 'voice-unlock', me])
      .catch(() => undefined),
  )
}

// Ticks the helpers' clock and checks them off as the app reports them done.
function startHelperTicker($: EngineInterface) {
  if (helperTicker !== undefined) return
  let tick = 0
  helperTicker = $.clock.every(1000, () => {
    tick++
    void update($, reply, now => (now === null ? now : { ...now, helperSeconds: (now.helperSeconds ?? 0) + 1 })).then(
      async now => {
        const running = (now?.helpers ?? []).filter(one => !one.isDone)
        if (running.length === 0) {
          helperTicker?.cancel()
          helperTicker = undefined
          return
        }
        if (tick % HELPER_POLL_S === 0) await checkHelpers($)
      },
    )
  })
}

async function checkHelpers($: EngineInterface) {
  const agents = await $.agent.list().catch(() => undefined)
  if (agents === undefined) return
  const finished = new Set(
    agents.filter(one => ['completed', 'failed', 'killed'].includes(one.status)).map(one => one.description),
  )
  const known = new Set(agents.map(one => one.description))
  await update($, reply, now =>
    now === null
      ? now
      : {
          ...now,
          // Done once the app says so, or once it has dropped the helper.
          helpers: (now.helpers ?? []).map(one =>
            one.isDone || finished.has(one.name) || (!known.has(one.name) && (now.helperSeconds ?? 0) > 5)
              ? { ...one, isDone: true }
              : one,
          ),
        },
  )
}

async function helperDone($: EngineInterface, name: string) {
  await update($, reply, now => {
    if (now === null) return now
    const at = (now.helpers ?? []).findIndex(one => one.name === name && !one.isDone)
    return at < 0 ? now : { ...now, helpers: (now.helpers ?? []).map((one, i) => (i === at ? { ...one, isDone: true } : one)) }
  })
}

// "2 sub-agents running · 1:12", then each one, ticked off as it finishes.
function helpersRow(ui: Kit, current: Reply, spinner: RenderChildren) {
  const { Box, Text } = ui
  const helpers = current.helpers ?? []
  const running = helpers.filter(one => !one.isDone).length
  if (helpers.length === 0 || (running === 0 && !current.isWorking)) return null
  return (
    <Box flexDirection="column" alignItems="flex-start" marginTop={1}>
      <Box flexDirection="row" gap={1} alignItems="center">
        {running > 0 ? spinner : <Text size="footnote" color={CLAUDE_ORANGE}>✓</Text>}
        <Text size="footnote" weight="medium">
          {running > 0 ? `${running} sub-agent${running === 1 ? '' : 's'} running` : 'Sub-agents done'}
        </Text>
        <Text size="footnote" tabular dimColor>
          · {clockOf(current.helperSeconds ?? 0)}
        </Text>
      </Box>
      {helpers.map((one, at) => (
        <Box key={`helper${at}`} flexDirection="row" gap={1}>
          <Text size="footnote" color={one.isDone ? CLAUDE_ORANGE : undefined} dimColor={!one.isDone}>
            {one.isDone ? '✓' : '○'}
          </Text>
          <Text size="footnote" dimColor strikethrough={one.isDone}>
            {one.name}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

// The buttons under what Claude is stuck on, in the chips' style.
function askButtons(ui: Kit, ask: PanelAsk, onAnswer: (value: string) => void) {
  const { Box, Button } = ui
  const question = ask.questions[ask.at]
  const choices =
    ask.kind === 'permission'
      ? [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }]
      : ask.kind === 'plan'
      ? [{ label: 'Approve', value: 'allow' }, { label: 'Keep planning', value: 'deny' }]
      : (question?.options ?? []).map(option => ({ label: option, value: option }))
  const isMulti = ask.kind === 'questions' && question?.isMulti === true
  return (
    <Box flexDirection="row" flexWrap="wrap" justifyContent="center" alignItems="center" gap={1} marginTop={1}>
      {choices.map((choice, at) => {
        const isPicked = isMulti && ask.picks.includes(choice.value)
        return (
          <Button
            key={`ask${at}`}
            variant={choice.value === 'deny' ? 'secondary' : 'primary'}
            hotkey={String(at + 1)}
            label={`${isPicked ? '✓ ' : ''}${choice.label}`}
            onPress={() => onAnswer(choice.value)}
          />
        )
      })}
    </Box>
  )
}

// A Copy chip: the command goes on your clipboard, with a tap and a ✓.
async function copyCommand($: EngineInterface, text: string, surface: CopySurface) {
  const result = await $.ui.copy({ text, surface })
  log($, `copy: ${result.isCopied ? 'copied' : `not copied (${result.reason})`}`)
  if (!result.isCopied) {
    $.ui.toast("Couldn't copy it: it's in the chat")
    return
  }
  cue($, 'tap', 0.8)
  await update($, reply, now => (now === null ? now : { ...now, copied: text }))
}

// Claude is stuck until you act (a permission prompt): the panel says so with
// the ding, out loud, and the spark holds still until the call goes on.
async function needsYouNow($: EngineInterface, text: string) {
  log($, `needs you: ${text}`)
  await update($, reply, now =>
    now === null
      ? now
      : {
          ...now,
          waiting: text,
          waitingTag: 'NEEDS YOU',
          lines: [
            ...now.lines,
            ...toCaptionLines(`${ATTENTION_INTRO} ${text}`, (now.lines.at(-1)?.sentence ?? -1) + 1, true),
          ],
        },
  )
  $.clock.after(0, () => void play($))
}

async function doneNeedingYou($: EngineInterface) {
  await update($, reply, now =>
    now !== null && now.waitingTag === 'NEEDS YOU' ? { ...now, waiting: '', waitingTag: undefined } : now,
  )
  await releaseAsk($)
}

// The app answered with its own dialog: the panel's buttons go, and the hook
// still waiting on them stops waiting.
async function releaseAsk($: EngineInterface) {
  const ask = (await read($, reply))?.ask
  if (ask === undefined || ask === null) return
  log($, `answered in the app: ${ask.kind}`)
  await update($, reply, now => (now === null || now.ask?.key !== ask.key ? now : { ...now, ask: null }))
  await $.fs.write(`${CLIP_DIR}/answer-${ask.key}`, '').catch(() => undefined)
}

// The red line's words for an API error.
function failureOf(error: string, details: string | undefined): string {
  const words: Record<string, string> = {
    rate_limit: 'Hit the usage limit.',
    overloaded: "Claude's servers are busy.",
    server_error: "Claude's servers had a problem.",
    billing_error: 'Out of Claude credit.',
    authentication_failed: "You're signed out.",
    max_output_tokens: 'The reply got too long.',
  }
  const detail = details !== undefined && details.length <= 80 ? ` ${details}` : ''
  return `${words[error] ?? 'Something went wrong.'}${detail}`.trim()
}

// A turn that died on an error or a refusal: said out loud, tagged NEEDS YOU.
async function endedBadly($: EngineInterface, id: number, isRefusal: boolean) {
  const text = isRefusal
    ? "I couldn't do that one. Try asking it another way."
    : 'Something went wrong and I stopped. Send your message again.'
  log($, `turn ended badly: ${text} (${lastFailure ?? 'no reason given'})`)
  await update($, reply, now =>
    now === null || now.id !== id
      ? now
      : {
          ...now,
          isWorking: false,
          gist: `Needs you: ${text}`,
          failure: isRefusal ? "Couldn't do that one." : (lastFailure ?? 'Something went wrong.'),
          lines: [
            ...now.lines,
            ...toCaptionLines(`${ATTENTION_INTRO} ${text}`, (now.lines.at(-1)?.sentence ?? -1) + 1, true),
          ],
          blocks: now.blocks.length > 0 ? now.blocks : [{ text, end: now.lines.length }],
        },
  )
}

// Says Bob's closing line again, captions and all.
async function replay($: EngineInterface) {
  await update($, reply, now => {
    if (now === null || now.gist === '') return now
    const last = now.lines.at(-1)?.sentence
    const start = Math.max(0, now.lines.findIndex(one => one.sentence === last))
    return { ...now, line: start, word: -1 }
  })
  $.clock.after(0, () => void play($))
}

// The picked chip lights at once, then the answer goes out as your message.
async function choose($: EngineInterface, text: string) {
  const now = await read($, reply)
  log($, `chip clicked: ${text}${now?.picked ? ` (already sent ${now.picked})` : ''}`)
  if (now === null || now.picked) return
  // Your answer counts as sent the moment you click: Bob moves straight to the
  // new reply (your message, the spinner, the clock) before the app takes it.
  cue($, 'tap', 0.8)
  await sendAnswer($, text)
}

// Sends a click's answer as your message: the panel moves on at once, and an
// answer the app holds back past ANSWER_FRESH_MS, or past a newer message of
// yours, is dropped when it finally comes through.
async function sendAnswer($: EngineInterface, text: string) {
  const fresh = await startReply($, text)
  pendingAnswer = { text, id: fresh, at: await $.clock.now() }
  const result = await $.prompt.submit({ text }).catch(error => ({ drop: reasonOf(error) }))
  if ('drop' in result && result.drop) log($, `answer not sent: ${result.drop}`)
}

async function startReply($: EngineInterface, prompt: string): Promise<number> {
  hush($)
  const fresh = await update($, reply, one => newReply((one?.id ?? 0) + 1, prompt))
  startTicking($)
  cue($, 'think', 0.3)
  return fresh?.id ?? 0
}

function toggleFull($: EngineInterface) {
  return update($, reply, now => (now === null ? now : { ...now, isFullAnswer: !now.isFullAnswer }))
}

async function toggleCardPane($: EngineInterface) {
  const { isCardInPane } = await read($, settings)
  if (isCardInPane) {
    await $.ui.close({ id: PANE })
  } else {
    await $.ui.open({ id: PANE, title: 'Claude' })
  }
  await saveSettings($, now => ({ ...now, isCardInPane: !isCardInPane }))
}

function newReply(id: number, prompt = ''): Reply {
  return {
    id,
    lines: [],
    line: 0,
    // -1 until the voice starts on the line: no caption shows ahead of it.
    word: -1,
    blocks: [],
    isWorking: true,
    isShowingAll: false,
    prompt,
    activity: 'Thinking',
    waiting: '',
    choice: null,
    picked: '',
    say: '',
    gist: '',
    points: [],
    pointAt: 0,
    isFullAnswer: false,
    plan: [],
    steps: [],
    seconds: 0,
  }
}

// Counts the seconds of the reply being worked on, for the status line.
function startTicking($: EngineInterface) {
  ticker?.cancel()
  let nextTypingAt = TYPING_FIRST_S
  ticker = $.clock.every(1000, () => {
    void update($, reply, now =>
      now !== null && now.isWorking ? { ...now, seconds: now.seconds + 1 } : now,
    ).then(now => {
      // A soft burst of typing now and then, so you can hear Claude working.
      if (now === null || !now.isWorking || now.waiting || now.seconds < nextTypingAt) return
      nextTypingAt = now.seconds + TYPING_GAP_S + Math.floor(Math.random() * TYPING_GAP_S)
      cue($, 'heartbeat', 0.8)
    })
  })
}

// Claude is at it again after the panel thought the reply was over (a stop
// hook sent it back to work): back to the spinning orb and the clock, never
// the idle card while work goes on.
async function stillWorking($: EngineInterface) {
  const now = await read($, reply)
  if (now === null || now.isWorking || finishingId === now.id) return
  log($, 'Claude is working again: back to thinking')
  await update($, reply, one =>
    one === null ? one : { ...one, isWorking: true, isShowingAll: false, activity: 'Thinking' },
  )
  startTicking($)
}

function setActivity($: EngineInterface, activity: string) {
  return update($, reply, now => (now === null || !now.isWorking ? now : { ...now, activity }))
}

async function addText($: EngineInterface, text: string) {
  log($, `heard ${text.length} characters`)
  // Claude sometimes says the same thing again after a tool call (a greeting, then a rename, then the greeting once
  // more): the same words twice in a row in one reply are said once.
  const before = await read($, reply)
  if (before !== null && before.blocks.at(-1)?.text === text.trim()) {
    log($, 'same message again, not said twice')
    return
  }
  await update($, reply, now => {
    const base = now ?? newReply(1)
    const firstSentence = (base.lines.at(-1)?.sentence ?? -1) + 1
    const lines = [...base.lines, ...toLines(text, firstSentence)]
    return { ...base, lines, blocks: [...base.blocks, { text: text.trim(), end: lines.length }] }
  })
  $.clock.after(0, () => void play($))
}

async function saveSettings($: EngineInterface, change: (now: Settings) => Settings) {
  await update($, settings, now => change(now as Settings))
  await $.store.set(STORE_KEY, await read($, settings))
  // 🔇 silences everything at once: Bob's voice and every sound under way.
  const { isVoiceOn } = await read($, settings)
  if (!isVoiceOn) {
    hush($)
    playingCues.forEach(stop => stop.abort())
  }
}

function skip($: EngineInterface) {
  hush($)
  return update($, reply, now => (now === null ? now : { ...now, line: now.lines.length }))
}

function showAll($: EngineInterface) {
  hush($)
  return update($, reply, now =>
    now === null ? now : { ...now, line: now.lines.length, isShowingAll: true },
  )
}

type RenderEvent = Parameters<EngineInterface['ui']['resolve']>[0]

// Bob himself: orb, captions, what Claude is doing and the finished card. The
// band above the message box draws him, and so does his side panel, which the
// app keeps on screen when its own next-step box takes the band's place.
async function drawStage($: EngineInterface, e: RenderEvent, where: 'band' | 'pane') {
  const { isVoiceOn, isCardInPane, isCompact } = await read($, settings)
  const current = await read($, reply)
  const mood = moodOf(current)
  const line = mood === 'talking' ? current?.lines[current.line] : undefined
  // Once Bob is done the orb steps back so your message and his summary lead.
  // Full size while Bob works or talks; once he is done it steps back a little
  // so your message and his summary fit.
  const isDone =
    mood === 'idle' && current !== null && current.blocks.length > 0 && !current.isShowingAll
  const orbSize = isCompact === true && where === 'band' ? 44 : isDone ? 72 : 104
  const ui = $.ui.resolve(e)
  const { Box, Button, Text } = ui
  const orb =
    'Svg' in ui ? (
      <ui.Svg source={spark(mood, isDone)} alt={`Claude, ${mood}`} width={orbSize} height={orbSize} isInteractive />
    ) : (
      <Text color={CLAUDE_ORANGE}>✻</Text>
    )
  const spinner =
    'Svg' in ui ? (
      <ui.Svg source={SPINNER} alt="working" width={14} height={14} isInteractive />
    ) : (
      <Text color={CLAUDE_ORANGE}>·</Text>
    )
  const isWorking = current !== null && current.isWorking
  // Work is over and the next words are on their way (the summary being
  // written, its voice fetched): say so, rather than show a still panel.
  const isPreparing =
    current !== null &&
    !current.isWorking &&
    mood === 'thinking' &&
    (current.line < current.lines.length || finishingId === current.id)
  const plan = current?.plan ?? []
  const recent = (current?.steps ?? []).slice(0, -1)
  // A question Bob is about to say out loud: its buttons wait until he has said it, instead of flashing up while
  // his voice is on the way, vanishing while he talks, then coming back.
  const isQuestionComing =
    current !== null && current.ask?.kind === 'questions' && isVoiceOn === true && current.line < current.lines.length
  // An Allow/Deny or plan prompt holds one steady view (its tag, the question, the buttons) until it is answered, while
  // Bob reads it out: switching between captions and that view at every pause made the buttons jump under the pointer.
  const isPromptUp = current !== null && Boolean(current.ask) && current.ask?.kind !== 'questions'

  return (
    <Box flexDirection="column" paddingX={1}>
      {current !== null && Boolean(current.voiceNote) && isVoiceOn === true ? (
        <Box position="absolute" top={0} left={0}>
          <Text size="footnote" dimColor>
            {current.voiceNote ?? ''}
          </Text>
        </Box>
      ) : null}
      {/* The icons float over the top-right corner, so they take no row. */}
      <Box position="absolute" top={0} right={0} flexDirection="row" alignItems="center" gap={2}>
        <Button
          key="pane"
          plain
          dimColor
          label={isCardInPane ? '⤡' : '⤢'}
          onPress={() => toggleCardPane($)}
        />
        <Button
          key="size"
          plain
          dimColor
          label={isCompact ? '+' : '–'}
          onPress={() => saveSettings($, now => ({ ...now, isCompact: !now.isCompact }))}
        />
        <Button
          key="voice"
          plain
          dimColor
          label={isVoiceOn ? '🔊' : '🔇'}
          onPress={() => saveSettings($, now => ({ ...now, isVoiceOn: !now.isVoiceOn }))}
        />
        <Button
          key="off"
          plain
          dimColor
          label="✕"
          onPress={() => saveSettings($, now => ({ ...now, isOn: false }))}
        />
      </Box>

      {isDone && current !== null && (
        <Box flexDirection="row" gap={2} alignItems="flex-start">
          {orb}
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            {card(ui, current, cardActions($), isCompact === true ? 'brief' : 'band')}
            {!isCompact && helpersRow(ui, current, spinner)}
          </Box>
        </Box>
      )}

      {!isDone && (
      <Box flexDirection="column" alignItems="center">
        {orb}
        {line !== undefined && !isPromptUp && (
          <Box flexDirection="row" flexWrap="wrap" justifyContent="center" marginTop={1}>
            {line.words.map((word, at) => {
              const isSaid = at === current?.word
              return (
                <Box key={`w${at}`} paddingX={1} backgroundColor={isSaid ? HIGHLIGHT : undefined}>
                  <Text size="title" weight="bold" color={isSaid ? '#FFFFFF' : undefined}>
                    {word}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}

        {(mood === 'waiting' || isPromptUp) && current !== null && !isQuestionComing && (
          <Box flexDirection="column" alignItems="center" gap={1} marginTop={1}>
            <Box paddingX={1} backgroundColor={HIGHLIGHT}>
              <Text size="caption" weight="bold" color="#FFFFFF">
                {current.waitingTag ?? 'QUESTION FOR YOU'}
              </Text>
            </Box>
            <Text size="heading" weight="bold">
              {current.waiting}
            </Text>
            {current.ask && askButtons(ui, current.ask, value => void answerAsk($, value))}
          </Box>
        )}


        {isPreparing && (
          <Box flexDirection="row" gap={1} alignItems="center" marginTop={1}>
            {spinner}
            <Text size="body" weight="medium">
              Putting it into words…
            </Text>
          </Box>
        )}

        {/* While a question's voice is still on the way the rows stay, so the panel keeps its size and the app's own
            question box behind it never shows through. */}
        {isWorking && (mood !== 'waiting' || isQuestionComing) && (
          <Box flexDirection="column" alignItems="flex-start" marginTop={1}>
            <Box flexDirection="row" gap={1} alignItems="center">
              {spinner}
              <Text size="body" weight="medium">
                {current.activity === 'Thinking' ? IDLE_WORDS[Math.floor(current.seconds / 3) % IDLE_WORDS.length] : current.activity}
              </Text>
              <Text size="footnote" tabular dimColor>
                {clockOf(current.seconds)}
              </Text>
            </Box>
            {isCompact
              ? null
              : plan.length > 0
              ? (() => {
                  // At most PLAN_ROWS rows: finished steps scroll off the top
                  // first, so the step under way stays in view with what follows.
                  const doing = plan.findIndex(item => item.status === 'doing')
                  const done = plan.filter(item => item.status === 'done').length
                  const focus = doing >= 0 ? doing : Math.min(done, plan.length - 1)
                  const first = Math.max(0, Math.min(focus - 1, plan.length - PLAN_ROWS))
                  return plan.slice(first, first + PLAN_ROWS).map((item, at) => (
                    <Box key={`plan${first + at}`} flexDirection="row" gap={1} alignItems="center">
                      {item.status === 'doing' ? (
                        spinner
                      ) : (
                        <Text size="footnote" color={item.status === 'done' ? CLAUDE_ORANGE : undefined} dimColor={item.status === 'todo'}>
                          {item.status === 'done' ? '✓' : '○'}
                        </Text>
                      )}
                      <Text size="footnote" dimColor={item.status !== 'doing'} strikethrough={item.status === 'done'}>
                        {item.text}
                      </Text>
                    </Box>
                  ))
                })()
              : recent.map((step, at) => (
                  <Box key={`step${at}`} flexDirection="row" gap={1}>
                    <Text size="footnote" color={CLAUDE_ORANGE}>
                      ✓
                    </Text>
                    <Text size="footnote" dimColor>
                      {step}
                    </Text>
                  </Box>
                ))}
            {!isCompact && helpersRow(ui, current, spinner)}
          </Box>
        )}

        {(mood === 'talking' || isQuestionComing) && (
          <Box flexDirection="row" gap={3} marginTop={1}>
            <Button key="skip" plain dimColor label="Skip" onPress={() => skip($)} />
            <Button key="all" plain dimColor label="Show full reply" onPress={() => showAll($)} />
          </Box>
        )}
      </Box>
      )}

      {!isDone && current !== null && !current.isShowingAll && (
        <Box marginTop={1}>
          {card(ui, current, cardActions($), isCompact === true ? 'brief' : 'band')}
        </Box>
      )}
    </Box>
  )
}

export const register: Register = (on, options) => {
  voice = String(options.voice ?? 'ash')

  on('session.start', async ($, e, next) => {
    log($, 'loaded')
    if ((await read($, owner)) === '') await update($, owner, () => `chat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
    const stored = (await $.store.get(STORE_KEY)) as Partial<Settings> | undefined
    if (stored) await update($, settings, now => ({ ...now, ...stored }))
    if (stored?.voiceName) voice = stored.voiceName
    const storedPace = await $.store.get(PACE_KEY)
    if (typeof storedPace === 'number') pace = storedPace
    const storedStreamPace = await $.store.get(STREAM_PACE_KEY)
    if (typeof storedStreamPace === 'number') streamPace = storedStreamPace

    // Mods reload as a turn ends, cancelling the reply's ending: finish it
    // from its last message, or pick it up where it stopped. No question can
    // still be open across a reload.
    // The caption Bob was in the middle of stays hidden until his voice
    // picks it up again, instead of hanging frozen meanwhile.
    // A line the old instance was saying keeps playing through the reload:
    // it counts as said, and the voice goes on only once it has finished.
    const isVoiceLeft = (await read($, reply))?.word !== -1 && (await isOldVoicePlaying($))
    await update($, reply, now =>
      now === null
        ? now
        : { ...now, waiting: '', word: -1, line: isVoiceLeft ? sentenceAt(now.lines, now.line).end : now.line },
    )
    if (isVoiceLeft) log($, 'reloaded mid-line: the line finishes, then the voice goes on')
    const left = await read($, reply)
    if (left !== null && left.isWorking && left.blocks.length > 0) {
      const last = left.blocks.at(-1)?.text ?? ''
      finishingId = left.id
      $.clock.after(500, () =>
        void finish($, left.id, last, false)
          .then(() => untilOldVoiceEnds($))
          .then(() => play($)),
      )
    } else if (left !== null && left.line < left.lines.length) {
      $.clock.after(500, () => void untilOldVoiceEnds($).then(() => play($)))
    }

    await $.command.register({
      name: 'bob',
      description: 'Claude captions: /bob on, off, voice, voices, voice <name>, style, sync earlier|later, skip or all',
      argumentHint: 'on | off | voice | voices | voice ash | style pro | sync earlier | sync later | skip | all',
    })

    return next(e)
  })

  on('command.run', { command: 'bob' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'off' || arg === 'on') {
      await saveSettings($, now => ({ ...now, isOn: arg === 'on' }))
      return { text: `Captions ${arg}.` }
    }
    const nudge = /^sync\s+(earlier|later)$/.exec(arg)?.[1]
    if (nudge !== undefined) {
      await saveSettings($, now => {
        const was = typeof now.syncMs === 'number' ? now.syncMs : 0
        return { ...now, syncMs: was + (nudge === 'earlier' ? -SYNC_STEP_MS : SYNC_STEP_MS) }
      })
      const { syncMs } = await read($, settings)
      return { text: `Highlight ${nudge}: now ${syncMs} ms against the voice.` }
    }
    if (VOICE_ENGINES.includes(arg)) {
      const engine = arg as VoiceEngine
      voiceCache.clear()
      await saveSettings($, now => ({ ...now, voiceEngine: engine }))
      if (engine !== 'mac' && (await findKey($)) === undefined) {
        return { text: `Claude will speak with ${ENGINE_NAMES[engine]} once your OpenAI key is in ~/.config/bob/openai.env. Until then it's the Mac's voice.` }
      }
      return { text: `Claude now speaks with ${ENGINE_NAMES[engine]}.` }
    }
    if (arg === 'voices') {
      $.clock.after(0, () => void playSamples($))
      return { text: `Playing ${SAMPLE_VOICES.join(', ')}, one after another. Pick one with /bob voice <name>.` }
    }
    const styled = /^style\s+(\w+)$/.exec(arg)?.[1]
    if (styled !== undefined) {
      if (!VOICE_STYLES.includes(styled)) return { text: `No style called ${styled}. Try: ${VOICE_STYLES.join(' or ')}.` }
      voiceCache.clear()
      await saveSettings($, now => ({ ...now, voiceStyle: styled }))
      return { text: `Claude now talks in the ${styled} style.` }
    }
    const picked = /^voice\s+(\w+)$/.exec(arg)?.[1]
    if (picked !== undefined) {
      if (!ALL_VOICES.includes(picked)) return { text: `No voice called ${picked}. Try one of: ${ALL_VOICES.join(', ')}.` }
      voice = picked
      voiceCache.clear()
      await saveSettings($, now => ({ ...now, voiceName: picked }))
      return { text: `Claude now speaks in the ${picked} voice.` }
    }
    if (arg === 'voice') {
      await saveSettings($, now => ({ ...now, isVoiceOn: !now.isVoiceOn }))
      const { isVoiceOn } = await read($, settings)
      return { text: `Voice ${isVoiceOn ? 'on' : 'off'}.` }
    }
    if (arg === 'skip') {
      await skip($)
      return { text: 'Skipped to the end of the reply.' }
    }
    if (arg === 'all') {
      await showAll($)
      return { text: 'Showing the full reply.' }
    }

    const { isOn, isVoiceOn } = await read($, settings)
    const engine = await engineOf($)
    const speaking = engine === 'mac' || (await findKey($)) === undefined ? ENGINE_NAMES.mac : `${ENGINE_NAMES[engine]}, ${voice}`
    return {
      text: `Captions ${isOn ? 'on' : 'off'}, voice ${isVoiceOn ? 'on' : 'off'} (${speaking}). Use /bob on, off, voice, mac, normal, live, skip or all.`,
    }
  })

  // A new prompt starts a new reply; whatever was still being said stops.
  on('prompt.submit', async ($, e, next) => {
    if (e.isMeta || e.command) return next(e)
    const text = e.text.trim()
    const origin = e.origin as { kind?: string; name?: string } | undefined

    // A helper's or a background job's result: the same reply goes on.
    if (origin?.kind === 'task-notification' || text.startsWith('<task-notification>')) {
      const finished = /<summary>Agent "([^"]+)"/.exec(text)?.[1]
      const result = await next(e)
      if (finished !== undefined) await helperDone($, finished)
      void checkHelpers($)
      await stillWorking($)
      return result
    }

    // A click's answer: already shown; sent only while still current.
    if (origin?.kind === 'plugin' && origin.name === 'bob-talks-back') {
      const now = await read($, reply)
      const pending = pendingAnswer
      const isFresh =
        pending !== undefined &&
        pending.text === text &&
        now?.id === pending.id &&
        (await $.clock.now()) - pending.at < ANSWER_FRESH_MS
      pendingAnswer = undefined
      if (!isFresh) {
        log($, `dropped a late click: ${text}`)
        return { drop: 'That click came too late: the conversation had moved on.' }
      }
      return next(e)
    }

    // Your message: the panel switches to it at once, before the app takes it.
    pendingAnswer = undefined
    const isNow = e.turnId === undefined
    if (isNow) await startReply($, text)
    const sentAt = await $.clock.now()
    const result = await next(e)
    const took = (await $.clock.now()) - sentAt
    if (took > 2000) log($, `your message took ${Math.round(took / 1000)}s to reach Claude`)
    if (!isNow) await startReply($, text)
    return result
  }).catch(($, e, next) => next(e))

  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (e.door !== 'response' || e.agentId !== undefined) return stored
    await stillWorking($)

    for (const block of e.message.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
        await addText($, block.text)
      }
    }

    return stored
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    if (!tool.startsWith('mcp__ccd_turn__')) await stillWorking($)

    if (tool === 'mcp__ccd_turn__update_plan') {
      await update($, reply, now =>
        now === null ? now : { ...now, plan: nextPlan(now.plan, input as PlanInput) },
      )
    } else if (tool === 'mcp__ccd_turn__wrap_up') {
      const choice = choiceOf(input)
      await update($, reply, now =>
        now === null
          ? now
          : { ...now, choice, plan: now.plan.map(item => ({ ...item, status: 'done' as const })) },
      )
      // The app hides Bob while its next-step box is up, so the question and
      // its answers live in Bob's panel and the box is never asked for.
      if (choice !== null) {
        log($, `took the next-step question into the captions panel: ${choice.ask}`)
        const { ask: _ask, actions: _actions, blocked: _blocked, ...rest } = input
        return next(rest as typeof e)
      }
    }

    // Claude stops to ask you something: the panel shows the question, the
    // asking sound plays and the spark holds still until you answer.
    if (tool === 'AskUserQuestion') {
      const questions = Array.isArray(input.questions) ? (input.questions as { question?: unknown }[]) : []
      const question = String(questions[0]?.question ?? 'Claude has a question for you')
      // Bob finishes the line he is on, then dings and reads the question out.
      await update($, reply, now =>
        now === null
          ? now
          : {
              ...now,
              waiting: question,
              lines: [
                ...now.lines,
                ...toCaptionLines(`${QUESTION_INTRO} ${question}`, (now.lines.at(-1)?.sentence ?? -1) + 1, true),
              ],
            },
      )
      $.clock.after(0, () => void play($))
      try {
        return await next(e)
      } finally {
        await update($, reply, now => (now === null ? now : { ...now, waiting: '' }))
        await releaseAsk($)
      }
    }

    const isHelper = tool === 'Agent' || tool === 'Task'
    const helperName = String(input.description ?? 'helper')
    if (isHelper) {
      await update($, reply, now =>
        now === null
          ? now
          : {
              ...now,
              helpers: [...(now.helpers ?? []), { name: helperName, isDone: false }],
              helperSeconds: (now.helpers ?? []).some(one => !one.isDone) ? now.helperSeconds : 0,
            },
      )
      startHelperTicker($)
    }
    const activity = activityOf(tool, input)
    await setActivity($, activity)
    if (activity !== 'Organizing') {
      await update($, reply, now =>
        now === null ? now : { ...now, steps: [...now.steps, activity].slice(-3) },
      )
    }
    let result: Awaited<ReturnType<typeof next>>
    try {
      result = await next(e)
    } finally {
      // A permission prompt for this call was answered.
      await doneNeedingYou($)
    }
    await setActivity($, 'Thinking')

    if (isHelper && input.run_in_background !== true) await helperDone($, helperName)
    const opened = openedOf(tool, input, result)
    if (opened.length > 0 && !('deny' in (result as object))) {
      log($, `opened on the right: ${opened.map(one => one.name).join(', ')}`)
      cue($, 'tap', 0.6)
      await update($, reply, now =>
        now === null ? now : { ...now, opened: [...(now.opened ?? []), ...opened].slice(-3) },
      )
    }

    return result
  }).catch(($, e, next) => next(e))

  // The app is about to ask you to allow a tool call: you would never see it
  // without opening the chat, so the panel says it out loud.
  // Its buttons (Allow / Deny, Approve / Keep planning, a question's options)
  // answer it from the panel; with no answer in ten minutes, the app's own
  // dialog is left to answer.
  on('classic.PermissionRequest', async ($, e, next) => {
    const beneath = await next(e)
    if (e.agent_id !== undefined || beneath.decision !== undefined) return beneath
    const input = (e.tool_input ?? {}) as Record<string, unknown>
    const key = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const ask = panelAskOf(e.tool_name, input, key)
    if (ask === undefined) return beneath

    if (ask.kind === 'questions') {
      const first = ask.questions[0]?.question ?? ''
      const now = await read($, reply)
      // Said already when the question tool started; said here if not.
      if (now !== null && now.waiting !== first) {
        await update($, reply, one =>
          one === null
            ? one
            : {
                ...one,
                waiting: first,
                lines: [...one.lines, ...toCaptionLines(`${QUESTION_INTRO} ${first}`, (one.lines.at(-1)?.sentence ?? -1) + 1, true)],
              },
        )
        $.clock.after(0, () => void play($))
      }
    } else if (ask.kind === 'plan') {
      const line = planLine(input)
      await needsYouNow($, line === '' ? 'The plan is ready. Approve it?' : `The plan is ready: ${/[.!?…]$/.test(line) ? line : `${line}.`} Approve it?`)
    } else {
      const what = activityOf(e.tool_name, input)
      await needsYouNow($, `I need your OK to go on: ${what.charAt(0).toLowerCase()}${what.slice(1)}.`)
    }
    await update($, reply, now => (now === null ? now : { ...now, ask }))

    const answer = await awaitPanelAnswer($, key, next.signal)
    await update($, reply, now => (now === null || now.ask?.key !== key ? now : { ...now, ask: null }))
    if (answer === undefined) return beneath
    log($, `answered from the panel: ${ask.kind} ${answer.slice(0, 80)}`)
    return { ...beneath, decision: decisionOf(ask, input, answer) }
  }).catch(($, e, next) => next(e))

  // Why a turn died, as the app reports it, for the red line under the reply.
  on('classic.StopFailure', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id === undefined) lastFailure = failureOf(e.error, e.error_details)
    return result
  }).catch(($, e, next) => next(e))

  // A turn that starts without a new prompt of yours (a hook sent Claude back
  // to work) carries on the same reply.
  on('turn.start', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) lastTurnStartAt = await $.clock.now()
    if (e.agentId === undefined) await stillWorking($)
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // A helper's end ticks it off in the panel.
    if (e.agentId !== undefined) {
      void checkHelpers($)
      return result
    }

    ticker?.cancel()
    log($, `turn complete, answer ${e.answer.length} characters`)


    const current = await read($, reply)
    if (current === null) return result
    if (current.blocks.length === 0 && e.answer.trim() !== '') await addText($, e.answer)
    finishingId = current.id
    const isBad = e.reason === 'error' || e.reason === 'refusal'
    if (!isBad) lastFailure = undefined
    if (e.isAborted) await update($, reply, now => (now === null || now.id !== current.id ? now : { ...now, failure: 'Stopped.' }))
    $.clock.after(0, () =>
      void finish($, current.id, e.answer, e.isAborted)
        .then(() => (isBad ? endedBadly($, current.id, e.reason === 'refusal') : undefined))
        .then(() => play($)),
    )

    return result
  })

  // The app's own "waiting on you" box (a wrap-up marked blocked, or with a question and buttons) takes the band's
  // place, and Bob vanishes for the rest of the turn while he goes on talking. So Claude asks in words, and Bob's
  // panel does the asking with its own buttons.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const { isOn } = await read($, settings)
    if (!isOn || !e.tools.includes('mcp__ccd_turn__wrap_up')) return composed
    return {
      sections: [
        ...composed.sections,
        {
          id: 'bob-talks-back:ask-in-words',
          text:
            'When you need the user, ask in plain words at the end of your reply. When you call mcp__ccd_turn__wrap_up, ' +
            'leave out `blocked`, `ask` and `actions`: the app would put its own box over the captions panel.',
          scope: 'session' as const,
        },
      ],
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { isOn, isCardInPane, isCompact } = await read($, settings)
    // The terminal's surveys draw in this band, so Bob gives way there; on the
    // desktop the app's own next-step box sits elsewhere and Bob stays.
    if (e.props.hasSurvey && e.surface !== 'desktop') return next(e)
    if (!isOn) {
      const { Box, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" justifyContent="flex-end">
          <Button
            key="show-bob"
            plain
            dimColor
            label="✻ Claude"
            onPress={() => saveSettings($, now => ({ ...now, isOn: true }))}
          />
        </Box>
      )
    }

    const current = await read($, reply)
    const mood = moodOf(current)
    const drawn = `${e.surface} ${mood} prompt=${current?.prompt.length ?? 0} blocks=${current?.blocks.length ?? 0} line=${current?.line ?? 0}/${current?.lines.length ?? 0} pane=${isCardInPane} compact=${isCompact} shown=${current?.isShowingAll ?? false} survey=${e.props.hasSurvey} choice=${current?.choice ? 'yes' : 'no'}`
    if (drawn !== lastDrawn) {
      lastDrawn = drawn
      log($, `band: ${drawn}`)
    }
    return drawStage($, e, 'band')
  }).catch(($, e, next) => {
    log($, `band drawing failed on ${e.surface}; drew the plain orb instead`)
    const ui = $.ui.resolve(e)
    return 'Svg' in ui ? (
      <ui.Box flexDirection="column" alignItems="center">
        <ui.Svg source={spark('idle')} alt="Claude" width={88} height={88} isInteractive />
      </ui.Box>
    ) : next(e)
  })

  // The side panel holds the card alone (the question, its answers, your
  // message); Bob himself stays in his spot above the message box.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const current = await read($, reply)
    const ui = $.ui.resolve(e)
    const drawn = current === null ? null : card(ui, current, cardActions($), 'pane')
    return drawn ?? <ui.Text dimColor>Nothing yet. Send Claude a message.</ui.Text>
  })

  on('ui.close', async ($, e, next) => {
    const result = await next(e)
    if (e.id === PANE) await update($, settings, now => ({ ...now, isCardInPane: false }))
    return result
  })

  // The reply being captioned stays one quiet line until Bob has said it,
  // then lands in the history as a normal message.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const { isOn } = await read($, settings)
    const current = await read($, reply)
    const isLive = isOn && current !== null && !current.isShowingAll && !e.props.isSummary

    if (!isLive || current === null) {
      settled.add(e.requestId)
      return next(e)
    }

    const block = current.blocks.find(one => one.text === e.props.text.trim())
    const isStreaming = block === undefined && current.isWorking && !settled.has(e.requestId)
    const isUnsaid = block !== undefined && current.line < block.end

    if (!isStreaming && !isUnsaid) {
      settled.add(e.requestId)
      return next(e)
    }

    const { Text } = $.ui.resolve(e)
    return <Text dimColor>· Claude is saying this…</Text>
  })
}
