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

export function checkGuard(tool: string, input: Record<string, unknown>, root: string): string | null {
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
  }
  return null
}
