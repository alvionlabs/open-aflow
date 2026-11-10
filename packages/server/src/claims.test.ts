import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { parseClaim, portsDir, readClaims } from './claims.ts'

describe('parseClaim', () => {
  test('reads the port base, a repo path with spaces, and the plan', () => {
    expect(parseClaim('3100', 'E:/My Repos/x plan-a')).toEqual({
      portBase: 3100,
      repoPath: 'E:/My Repos/x',
      plan: 'plan-a',
    })
    // The live format ends in a newline; extra spaces around parts are trimmed.
    expect(parseClaim('3000', 'E:/Projects/openaflow board-read\n')).toEqual({
      portBase: 3000,
      repoPath: 'E:/Projects/openaflow',
      plan: 'board-read',
    })
    expect(parseClaim('3200', '  /home/me/my  repo \t plan-b  \r\n')).toEqual({
      portBase: 3200,
      repoPath: '/home/me/my  repo',
      plan: 'plan-b',
    })
  })

  test('a bad file name, empty text, or one token gives undefined', () => {
    for (const name of ['abc', '3100.txt', '31 00', '', '-3100', '3100.5', '0', '65536', '0x10']) {
      expect(parseClaim(name, 'E:/x plan-a'), name).toBeUndefined()
    }
    for (const text of ['', '   ', '\n', 'E:/x', '  plan-a  ']) {
      expect(parseClaim('3100', text), JSON.stringify(text)).toBeUndefined()
    }
  })

  test('a relative repo path or text over several lines gives undefined', () => {
    expect(parseClaim('3100', 'relative/x plan-a')).toBeUndefined()
    expect(parseClaim('3100', 'E:/x plan-a\nE:/y plan-b')).toBeUndefined()
  })
})

describe('portsDir', () => {
  test('OPENAFLOW_PORTS_DIR, else <temp>/pod-ports', () => {
    expect(portsDir({ OPENAFLOW_PORTS_DIR: '/p' }, '/tmp')).toBe('/p')
    expect(portsDir({}, join('T', 'emp'))).toBe(join('T', 'emp', 'pod-ports'))
    expect(portsDir({ OPENAFLOW_PORTS_DIR: '' }, 'T')).toBe(join('T', 'pod-ports'))
  })
})

describe('readClaims', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openaflow-d1-claims-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('a missing ports folder gives []', async () => {
    expect(await readClaims(join(root, 'no-such-folder'))).toEqual([])
  })

  test('keeps live claims sorted by port and drops one for a deleted repo', async () => {
    const ports = join(root, 'pod-ports')
    const live = join(root, 'live repo')
    await mkdir(ports)
    await mkdir(live)
    await writeFile(join(ports, '3200'), `${live} plan-b\n`)
    await writeFile(join(ports, '3100'), `${live} plan-a\n`)
    await writeFile(join(ports, '3300'), `${join(root, 'deleted')} plan-c\n`)
    await writeFile(join(ports, 'notes.txt'), `${live} plan-x\n`)
    await writeFile(join(ports, '3400'), '')
    await mkdir(join(ports, '3500'))
    // A claim pointing at a file, not a folder, is dropped too.
    await writeFile(join(root, 'plain'), 'x')
    await writeFile(join(ports, '3600'), `${join(root, 'plain')} plan-d\n`)

    expect(await readClaims(ports)).toEqual([
      { portBase: 3100, repoPath: live, plan: 'plan-a' },
      { portBase: 3200, repoPath: live, plan: 'plan-b' },
    ])
  })
})
