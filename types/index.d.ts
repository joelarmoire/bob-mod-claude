// `spoken`: said out loud (the closing summary, a question); other lines are
// silent captions, which cost nothing.
export type CaptionLine = { words: string[]; sentence: number; spoken?: true }

export type PlanItem = { text: string; status: 'todo' | 'doing' | 'done' }

export type ChoiceOption = { label: string; text: string }

// The question Claude's reply ends on, as the app's next-step box asks it.
export type Choice = { ask: string; options: ChoiceOption[] }

export type ReplyBlock = { text: string; end: number }

// Something Claude is stuck on until you answer it in the panel: a permission
// prompt, a plan to approve, or one or more questions (one shown at a time).
export type PanelAsk = {
  kind: 'permission' | 'plan' | 'questions'
  // Names the answer file the waiting hook reads.
  key: string
  questions: { question: string; options: string[]; isMulti: boolean }[]
  at: number
  // The toggles picked so far on a multiple-choice question.
  picks: string[]
  answers: string[]
}

// A helper (subagent) Claude started, ticked off once it finishes.
export type Helper = { name: string; isDone: boolean }

// A file or page Claude put on the right; `target` is what Open opens.
export type Opened = { name: string; target: string }

export type Reply = {
  id: number
  lines: CaptionLine[]
  line: number
  word: number
  blocks: ReplyBlock[]
  isWorking: boolean
  isShowingAll: boolean
  prompt: string
  activity: string
  // The question Claude is waiting on you to answer; empty when none.
  waiting: string
  choice: Choice | null
  // The answer you clicked, sent once; empty until then.
  picked: string
  gist: string
  // What the reply actually says, in a sentence or two that stand on their own.
  say: string
  points: string[]
  pointAt: number
  isFullAnswer: boolean
  plan: PlanItem[]
  steps: string[]
  seconds: number
  // The tag over `waiting`: QUESTION FOR YOU, or NEEDS YOU for a permission
  // prompt. Absent in replies saved before it existed.
  waitingTag?: string
  // Files and pages Claude opened on the right during the reply.
  opened?: Opened[]
  ask?: PanelAsk | null
  helpers?: Helper[]
  helperSeconds?: number
  // Why the reply ended early (an error, a refusal, a stop); shown in red.
  failure?: string
  // Set while the voice can't speak (it failed, or OpenAI credit ran out).
  voiceNote?: string
  // The command last put on your clipboard from the card.
  copied?: string
  // The text to copy whose Show was pressed: it stays open in the panel until hidden.
  shownCopy?: string
  // The copy-card names the panel tool handed over, when it did.
  copyNames?: string[]
  // Why the full reply has to be read, when Claude said it does: the button then stands out.
  mustRead?: string
}

export type Settings = {
  isOn: boolean
  isVoiceOn: boolean
  isCardInPane: boolean
  isCompact: boolean
  // The OpenAI voice you picked with /bob voice <name>; empty for the default.
  voiceName?: string
  // How the live voice delivers: pro (brisk, articulate) or narrator (slower).
  voiceStyle?: string
  // Nudge for the highlight against the voice, in ms; negative is earlier.
  syncMs?: number
  // Which voice speaks: mac (free, the default), normal or live (OpenAI). Set with /bob mac, normal or live.
  voiceEngine?: 'mac' | 'normal' | 'live'
  // The sounds (send, heartbeat, ding, done), muted apart from the voice; unset follows the voice, as before.
  isSoundOn?: boolean
  /** ⏭ on: every answer goes straight to its card, nothing read out or played as captions. */
  isAutoSkip?: boolean
  // The mic you talk into with 🎙: picked with /bob mic, or the last one that heard you.
  micName?: string
}

// Talking to Claude with 🎙: the mic opening, listening until Done, writing out what you said; `draft` holds it when
// the message box could not take it, for the panel's Send and Copy.
export type MicState = {
  phase: 'off' | 'starting' | 'listening' | 'writing'
  device?: string
  draft?: string
}

declare module 'claude-code' {
  interface PluginState {
    // owner: this chat's name on the shared voice lock, the same across reloads.
    // muteMenu: the 🔊 chooser is open.
    // mic: talking to Claude with 🎙.
    'bob-talks-back': { reply: Reply | null; settings: Settings; owner: string; muteMenu: boolean; mic: MicState }
  }
}
