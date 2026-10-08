/**
 * Guard: what a subagent may not do without a human, whatever its task.
 * Pure: takes the tool, its input and the project root, says why it is out of
 * bounds or null. A best-effort net on the obvious moves, not a sandbox: a shell
 * command can always reach further than a pattern can see.
 */

const TEST_FILE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/
const SKIP = /\b(it|test|describe)\.skip\s*\(|\bx(it|describe)\s*\(|\{\s*skip\s*:\s*true/

/** Folds `.` and `..` out of an absolute path. */
export function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

export function isInside(root: string, path: string): boolean {
  if (path.startsWith('~')) return false
  const abs = normalize(path.startsWith('/') ? path : `${root}/${path}`)
  const base = normalize(root)
  return abs === base || abs.startsWith(`${base}/`)
}

function textsOf(input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const key of ['new_string', 'content', 'new_source']) {
    const v = input[key]
    if (typeof v === 'string') out.push(v)
  }
  const edits = input.edits
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const v = (edit as Record<string, unknown>).new_string
      if (typeof v === 'string') out.push(v)
    }
  }
  return out
}

const WRITERS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TEST_CASE = /\b(it|test)\s*\(/g

/** How many test cases a piece of a test file declares. */
export function countTests(text: string): number {
  return text.match(TEST_CASE)?.length ?? 0
}

/** What an edit replaces, beside what it writes: the tests it takes away. */
function removedTests(input: Record<string, unknown>, current: string | null): number {
  const pairs: [string, string][] = []
  if (typeof input.old_string === 'string' && typeof input.new_string === 'string') pairs.push([input.old_string, input.new_string])
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      const e = edit as Record<string, unknown>
      if (typeof e.old_string === 'string' && typeof e.new_string === 'string') pairs.push([e.old_string, e.new_string])
    }
  }
  if (typeof input.content === 'string' && current !== null) pairs.push([current, input.content])
  return pairs.reduce((n, [before, after]) => n + Math.max(0, countTests(before) - countTests(after)), 0)
}

/**
 * `current` is the file as it stands, for a Write that replaces a whole test
 * file (null when it does not exist yet or could not be read).
 */
export function checkGuard(tool: string, input: Record<string, unknown>, root: string, current: string | null = null): string | null {
  if (tool === 'Bash' && typeof input.command === 'string') {
    const cmd = input.command
    if (/\bgit\b[^;&|\n]*\bpush\b/.test(cmd)) return 'pushing is out of scope for a background agent'
    if (/--no-verify\b/.test(cmd)) return 'skipping git hooks (--no-verify)'
    if (/(^|[;&|\s])(rm|unlink|git\s+rm)\b[^;&|\n]*(\btests?\b|__tests__|\.test\.|\.spec\.)/.test(cmd)) return 'deleting tests'
    return null
  }
  if (WRITERS.has(tool)) {
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
    if (path !== '' && !isInside(root, path)) return `writing outside the project (${path})`
    if (TEST_FILE.test(path) && textsOf(input).some(text => SKIP.test(text))) return 'switching tests off with .skip'
    if (TEST_FILE.test(path)) {
      const removed = removedTests(input, current)
      if (removed > 0) return `deleting ${removed} test${removed === 1 ? '' : 's'} from ${path.split('/').pop()}`
    }
  }
  return null
}
