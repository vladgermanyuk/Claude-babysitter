import { describe, expect, test } from 'claude-code/testing'

import { checkGuard, isInside } from '../hooks/guard'

const ROOT = '/work/shop-api'

describe('Bash', () => {
  const bash = (command: string) => checkGuard('Bash', { command }, ROOT)

  test('git push, in any spelling', () => {
    expect(bash('git push')).toContain('pushing')
    expect(bash('git add -A && git commit -m x && git push origin main')).toContain('pushing')
    expect(bash('git -C . push --force')).toContain('pushing')
  })

  test('deleting tests', () => {
    expect(bash('rm test/price.test.js')).toBe('deleting tests')
    expect(bash('rm -rf tests')).toBe('deleting tests')
    expect(bash('git rm src/price.spec.ts')).toBe('deleting tests')
  })

  test('--no-verify', () => {
    expect(bash('git commit --no-verify -m wip')).toContain('--no-verify')
  })

  test('ordinary work passes', () => {
    expect(bash('node --test test/price.test.js')).toBe(null)
    expect(bash('git commit -am "fix discount cap"')).toBe(null)
    expect(bash('rm -rf node_modules')).toBe(null)
    expect(bash('git status && git diff')).toBe(null)
  })
})

describe('writes', () => {
  test('outside the project is refused', () => {
    expect(checkGuard('Edit', { file_path: '/etc/hosts', new_string: 'x' }, ROOT)).toContain('outside the project')
    expect(checkGuard('Write', { file_path: '../other/app.js', content: 'x' }, ROOT)).toContain('outside the project')
    expect(checkGuard('Write', { file_path: '~/.zshrc', content: 'x' }, ROOT)).toContain('outside the project')
  })

  test('inside the project passes', () => {
    expect(checkGuard('Edit', { file_path: `${ROOT}/src/price.js`, new_string: 'x' }, ROOT)).toBe(null)
    expect(checkGuard('Write', { file_path: 'test/date.test.js', content: "test('x', () => {})" }, ROOT)).toBe(null)
  })

  test('switching a test off with .skip is refused', () => {
    expect(checkGuard('Edit', { file_path: `${ROOT}/test/price.test.js`, new_string: "test.skip('caps every discount at 50%'" }, ROOT)).toContain('.skip')
    expect(checkGuard('Edit', { file_path: `${ROOT}/test/a.test.js`, new_string: "test('x', { skip: true }, () => {})" }, ROOT)).toContain('.skip')
    expect(checkGuard('MultiEdit', { file_path: `${ROOT}/test/a.spec.ts`, edits: [{ old_string: 'it(', new_string: 'xit(' }] }, ROOT)).toContain('.skip')
  })

  test('editing a test case out of a test file is refused', () => {
    const old = "test('applies a 60% clearance discount', () => {\n  assert.equal(applyDiscount(10_000, 60), 4_000)\n})\n"
    expect(checkGuard('Edit', { file_path: `${ROOT}/test/price.test.js`, old_string: old, new_string: '' }, ROOT)).toBe('deleting 1 test from price.test.js')
  })

  test('a Write that drops tests from an existing file is refused', () => {
    const current = "test('a', () => {})\ntest('b', () => {})\n"
    expect(checkGuard('Write', { file_path: `${ROOT}/test/a.test.js`, content: "test('a', () => {})\n" }, ROOT, current)).toBe('deleting 1 test from a.test.js')
  })

  test('changing an expectation or adding tests passes', () => {
    expect(checkGuard('Edit', { file_path: `${ROOT}/test/price.test.js`, old_string: 'equal(x, 1)', new_string: 'equal(x, 2)' }, ROOT)).toBe(null)
    expect(checkGuard('Edit', { file_path: `${ROOT}/test/a.test.js`, old_string: "test('a', f)", new_string: "test('a', f)\ntest('b', g)" }, ROOT)).toBe(null)
    expect(checkGuard('Write', { file_path: `${ROOT}/test/new.test.js`, content: "test('a', () => {})" }, ROOT, null)).toBe(null)
  })

  test('.skip outside a test file is not the guard\'s business', () => {
    expect(checkGuard('Edit', { file_path: `${ROOT}/src/list.js`, new_string: 'list.skip(2)' }, ROOT)).toBe(null)
  })
})

test('isInside folds .. and refuses lookalike siblings', () => {
  expect(isInside(ROOT, `${ROOT}/src/../test/a.js`)).toBe(true)
  expect(isInside(ROOT, `${ROOT}-old/src/a.js`)).toBe(false)
  expect(isInside(ROOT, `${ROOT}/../../etc/passwd`)).toBe(false)
})
