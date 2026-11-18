/** Pure form and correlation helpers shared by the workbench page and its tests (T10/T05).
 *
 *  Three rules live here so they can be tested without a browser:
 *  - a model choice is only the platform catalog's own entry, never a free-form provider/model id;
 *  - an answer is built exactly once per native question, with the same ids the Host sent;
 *  - an enterprise submission is derived from a *durable native user message* carrying its
 *    client-minted `rpcId`, not from DOM events or a second chat protocol.
 */

export interface FormModelEntry {
  selectionId: string
  provider?: string
  model?: string
  displayName?: string
  enabled?: boolean
  available?: boolean
  unavailableReason?: string | null
}

export interface FormModelCatalog {
  defaultSelectionId?: string | null
  entries?: FormModelEntry[]
}

export interface FormModelPreference {
  selectionId?: string | null
  state?: string
}

export interface ModelChoice {
  selectionId: string
  label: string
  available: boolean
  selected: boolean
  unavailableReason?: string
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The catalog's entries with availability and the current selection resolved, in catalog order. */
export function modelChoices(
  catalog: FormModelCatalog | null | undefined,
  preference: FormModelPreference | null | undefined,
): ModelChoice[] {
  const entries = Array.isArray(catalog?.entries) ? catalog.entries : []
  const selectedId =
    typeof preference?.selectionId === 'string' && preference.selectionId
      ? preference.selectionId
      : typeof catalog?.defaultSelectionId === 'string'
        ? catalog.defaultSelectionId
        : ''
  return entries
    .filter((entry): entry is FormModelEntry => isObject(entry) && typeof entry.selectionId === 'string' && entry.selectionId.length > 0)
    .map((entry) => ({
      selectionId: entry.selectionId,
      label: entry.displayName || entry.model || entry.selectionId,
      available: entry.available === true || (entry.available === undefined && entry.enabled === true),
      selected: entry.selectionId === selectedId,
      ...(entry.unavailableReason ? { unavailableReason: entry.unavailableReason } : {}),
    }))
}

/**
 * The selection a new run should use: the employee's saved preference when it is available,
 * otherwise the catalog default, otherwise the first available entry. An unavailable saved
 * preference is never silently replaced in the preference itself — this only picks a run value.
 */
export function chosenModel(
  catalog: FormModelCatalog | null | undefined,
  preference: FormModelPreference | null | undefined,
): string | null {
  const choices = modelChoices(catalog, preference)
  const available = choices.filter((choice) => choice.available)
  const preferred = available.find((choice) => choice.selected)
  if (preferred) return preferred.selectionId
  const fallbackDefault = available.find((choice) => choice.selectionId === catalog?.defaultSelectionId)
  if (fallbackDefault) return fallbackDefault.selectionId
  return available[0]?.selectionId ?? null
}

/**
 * The input batch a run started from (SC-03): the frozen identity of the batch — never the
 * content — so the run's own frozen input digest covers which batch it belongs to. Kept as a
 * separate envelope key instead of folding it into the goal text, so plugins that ignore it are
 * unaffected and plugins that read it get structured facts.
 */
export interface RunInputBaseline {
  baselineId: string;
  revision: number;
  sourceRef: string;
  digest: string;
}

/**
 * The envelope one platform run receives. A Listing release declares its own scenarios; the
 * chosen one travels as `applicationOptions.listingType` so the Worker sees the business entry
 * instead of guessing it from the goal text. Without a scenario the input stays unchanged.
 * `inputBaseline` records which input batch this run started from; it is frozen with the input,
 * so a rerun on a new batch stays traceable to both the new and the previous batch.
 */
export function runInput(goal: string, listingType?: string, baseline?: RunInputBaseline): {
  goal: string; applicationOptions?: { listingType: string }; inputBaseline?: RunInputBaseline;
} {
  const text = goal.trim()
  if (!text) throw new Error('RUN_GOAL_REQUIRED')
  return {
    goal: text,
    ...(typeof listingType === 'string' && listingType.length > 0
      ? { applicationOptions: { listingType } }
      : {}),
    ...(baseline ? { inputBaseline: baseline } : {}),
  }
}

export interface NativeUserSubmission {
  /** Client-minted native request id (`rpcId`), the same key the Host deduplicates on. */
  requestId: string
  /** Durable Session event seq that proved the message entered the model-visible surface. */
  seq: number
  /** Durable event time (epoch ms) when the Host recorded it, when present. */
  time?: number
  /** Exact text the employee sent, joined from the message's text blocks. */
  text: string
}

/**
 * Extract one enterprise submission from a durable native Session event.
 * Only a real `user/message` whose source is the browser prompt (`kind: 'user'` with `rpcId`)
 * counts: synthetic `agent.inject()` context, steering/queue rows without an rpcId, and live
 * transient chunks all return null instead of being guessed into a submission.
 */
export function nativeUserSubmission(event: unknown): NativeUserSubmission | null {
  if (!isObject(event) || event.type !== 'user/message') return null
  if (typeof event.seq !== 'number' || !Number.isSafeInteger(event.seq) || event.seq < 0) return null
  const data = event.data
  if (!isObject(data) || !isObject(data.source)) return null
  const source = data.source
  if (source.kind !== 'user' || typeof source.rpcId !== 'string' || source.rpcId.length === 0) return null
  const blocks = Array.isArray(data.content) ? data.content : []
  const text = blocks
    .filter((block): block is { type: 'text'; text: string } =>
      isObject(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  return {
    requestId: source.rpcId,
    seq: event.seq,
    ...(typeof event.time === 'number' && Number.isFinite(event.time) ? { time: event.time } : {}),
    text,
  }
}

export interface NativeQuestion {
  id: string
  question?: string
  options?: Array<{ label: string } | string>
  multiSelect?: boolean
}

export interface AnswerInput {
  selected: string[]
  custom?: string
}

/**
 * Build the control plane's answer envelope from the questions the Host actually sent.
 * Every question must be answered exactly once, and a selection outside the Host's option
 * labels is refused here rather than being sent as an answer nobody offered.
 */
export function buildAnswers(
  questions: readonly NativeQuestion[],
  values: Readonly<Record<string, AnswerInput>>,
): Array<{ id: string; selected: string[]; custom?: string }> {
  if (questions.length === 0) throw new Error('ANSWER_QUESTIONS_EMPTY')
  const seen = new Set<string>()
  const answers = questions.map((question) => {
    if (!question || typeof question.id !== 'string' || !question.id) throw new Error('ANSWER_QUESTION_INVALID')
    if (seen.has(question.id)) throw new Error('ANSWER_QUESTION_DUPLICATE')
    seen.add(question.id)
    const value = values[question.id]
    if (!value) throw new Error('ANSWER_REQUIRED')
    const allowed = new Set(
      (question.options ?? [])
        .map((option) => (typeof option === 'string' ? option : option?.label))
        .filter((label): label is string => typeof label === 'string' && label.length > 0),
    )
    const selected = Array.isArray(value.selected) ? value.selected : []
    if (selected.some((label) => typeof label !== 'string' || !allowed.has(label))) {
      throw new Error('ANSWER_OPTION_UNKNOWN')
    }
    if (question.multiSelect !== true && selected.length > 1) throw new Error('ANSWER_SINGLE_SELECT')
    const custom = typeof value.custom === 'string' ? value.custom.trim() : ''
    if (selected.length === 0 && !custom) throw new Error('ANSWER_REQUIRED')
    return { id: question.id, selected: [...selected], ...(custom ? { custom } : {}) }
  })
  return answers
}
