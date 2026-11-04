// The production entry: the web build sits in a `web` folder beside this file, wherever it runs from.

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMain } from './start-server.ts'

await runMain({ production: { webDir: join(dirname(fileURLToPath(import.meta.url)), 'web') } })
