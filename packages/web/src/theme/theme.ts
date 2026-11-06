/** The viewer's theme pick. `system` follows `prefers-color-scheme`; nothing stored means `dark`. */
export type ThemeChoice = 'system' | 'light' | 'dark'

/** The part of `Storage` the theme needs, so tests can pass a plain object. */
export type ChoiceStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void }

/** The part of an element the theme needs (in the app, `document.documentElement`). */
export type ThemeRoot = { setAttribute(name: string, value: string): void; removeAttribute(name: string): void }

export const THEME_KEY = 'open-aflow-theme'

const CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark']

function isChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (CHOICES as readonly string[]).includes(value)
}

/** The theme when nothing usable is stored. index.html's boot script follows the same rule. */
export const DEFAULT_CHOICE: ThemeChoice = 'dark'

/** The stored choice; anything missing, unknown, or unreadable reads as `dark`. */
export function readChoice(storage: ChoiceStorage | null | undefined): ThemeChoice {
  try {
    const value = storage?.getItem(THEME_KEY)
    return isChoice(value) ? value : DEFAULT_CHOICE
  } catch {
    return DEFAULT_CHOICE
  }
}

/** Stores the choice. A storage that refuses (private mode, blocked site data) is ignored. */
export function saveChoice(storage: ChoiceStorage | null | undefined, choice: ThemeChoice): void {
  try {
    storage?.setItem(THEME_KEY, choice)
  } catch {
    // The choice still applies for this page view; it just isn't remembered.
  }
}

/** `light` and `dark` set `data-theme`; `system` removes it so the media query decides. */
export function applyTheme(choice: ThemeChoice, root: ThemeRoot): void {
  if (choice === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', choice)
}
