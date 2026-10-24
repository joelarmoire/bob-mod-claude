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
}

declare module 'claude-code' {
  interface PluginState {
    // owner: this chat's name on the shared voice lock, the same across reloads.
    'bob-mod-claude': { reply: Reply | null; settings: Settings; owner: string }
  }
}
