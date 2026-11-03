// The setup check's two routes. `createApp` mounts them behind its guards, in production only.

import { Hono } from 'hono'
import { TOOL_NAMES, type ToolFinder, type ToolName } from './tool-finder.ts'

export type ToolRoutesDeps = Pick<ToolFinder, 'check' | 'setPath'>

const isToolName = (value: unknown): value is ToolName => TOOL_NAMES.includes(value as ToolName)

export function createToolRoutes(tools: ToolRoutesDeps): Hono {
  return new Hono()
    .get('/api/tools', async (c) => c.json({ tools: await tools.check() }))
    .post('/api/actions/tool-path', async (c) => {
      // The action guard has checked the type, the token, and that the body is a JSON object.
      const { tool, path } = (await c.req.json()) as { tool?: unknown; path?: unknown }
      if (!isToolName(tool) || !(typeof path === 'string' || path === null)) return c.json({ error: 'bad request' }, 400)
      const result = await tools.setPath(tool, path)
      if ('tools' in result) return c.json({ tools: result.tools })
      return c.json({ error: result.error }, result.error === 'settings unwritable' ? 500 : 400)
    })
}
