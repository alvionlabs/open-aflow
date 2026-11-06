import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (name: string) => {
  const file = join(ROOT, name)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

describe('docs/install.md', () => {
  test('note covers its topics', () => {
    const note = read('docs/install.md')
    for (const term of ['SmartScreen', 'Smart App Control', 'git', 'gh', 'claude', 'CLAUDE', 'settings.json']) expect(note, term).toContain(term)
    expect(note).toMatch(/uninstall/i)
    expect(read('README.md')).toMatch(/\]\(docs\/install\.md\)/)
  })

  // PR #79 changed which variables a resumed run keeps, so the note names them.
  test('the CLAUDE note names what a resumed run keeps', () => {
    const note = read('docs/install.md')
    for (const name of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS']) expect(note, name).toContain(name)
  })

  test('the note names pod and how to install it, under the tools you need', () => {
    const tools = read('docs/install.md').split('## Tools you need')[1]!.split('\n## ')[0]!
    const line = tools.split('\n').find((l) => l.startsWith('- `pod`')) ?? ''
    expect(line).toContain('https://github.com/iamphduc/claude-pod')
    expect(line).toContain('`/plugin marketplace add iamphduc/claude-pod`')
    expect(line).toContain('`/plugin install pod@pod`')
    expect(line).toMatch(/Claude Code/)
  })

  test("the note doesn't say the setup check looks for pod", () => {
    const check = read('docs/install.md').split('## The setup check')[1]!.split('\n## ')[0]!
    expect(check).toContain("It doesn't look for pod")
    expect(check).not.toContain('these tools')
  })

  test('the note names where to download and the config folder that stays', () => {
    const note = read('docs/install.md')
    expect(note).toContain('https://github.com/alvionlabs/open-aflow/releases/latest')
    expect(note).toContain('%APPDATA%\\open-aflow')
    expect(note).toContain('`open-aflow-setup-<version>.exe`')
    expect(note).toContain('%APPDATA%\\Open AFlow\\desktop.log')
    expect(note).toContain('find **Open AFlow**')
  })
})
