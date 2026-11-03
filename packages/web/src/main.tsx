import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './theme/index.css'
import { applyTheme, readChoice } from './theme/theme.ts'
import { App } from './App.tsx'
import { SetupGate } from './screens/setup/SetupScreen.tsx'

const storage = (() => {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
})()
applyTheme(readChoice(storage), document.documentElement)

const root = document.getElementById('root')
if (!root) throw new Error('#root is missing from index.html')

createRoot(root).render(
  <StrictMode>
    <SetupGate>
      <App />
    </SetupGate>
  </StrictMode>,
)
