// Stub: the tests in tool-routes.test.ts come first.

import { Hono } from 'hono'
import type { ToolFinder } from './tool-finder.ts'

export type ToolRoutesDeps = Pick<ToolFinder, 'check' | 'setPath'>

export function createToolRoutes(_tools: ToolRoutesDeps): Hono {
  return new Hono()
}
