// The Electron entry. All the wiring is in shell-main.ts, which the guarded probe runs too.

import { startShell } from './shell-main.ts'

startShell({ env: process.env })
