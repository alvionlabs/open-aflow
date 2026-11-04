import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    // Server tests do real file I/O in the temp folder. When other work competes for the disk, one temp-folder
    // cycle goes from about 6 ms to over 1.5 s, while CPU only doubles, so a 100 ms test can pass 5 s with no race.
    // These bounds only catch a hang: a healthy run never waits for them.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
