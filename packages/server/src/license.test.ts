import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

test('the repo is MIT licensed', () => {
  const file = join(root, 'LICENSE')
  expect(existsSync(file)).toBe(true)
  const text = readFileSync(file, 'utf8').replace(/\s+/g, ' ')
  expect(text).toContain('MIT License')
  expect(text).toContain('Copyright (c) 2026 Duc Pham')
  expect(text).toContain('Permission is hereby granted, free of charge, to any person obtaining a copy of this software')
  expect(text).toContain('The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.')
  expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { license?: string }
  expect(pkg.license).toBe('MIT')
})
