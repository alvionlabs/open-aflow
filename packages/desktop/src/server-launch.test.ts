import { join, sep } from 'node:path'
import { describe, expect, test } from 'vitest'
import { serverEntry, serverEnv } from './server-launch.ts'

describe('server launch', () => {
  test('finds the bundle', () => {
    const appPath = join('E:', 'repo', 'packages', 'desktop')
    const resourcesPath = join('C:', 'pod', 'resources')
    expect(serverEntry({ packaged: false, appPath, resourcesPath })).toBe(join('E:', 'repo', 'packages', 'server', 'dist', 'app', 'server.mjs'))

    const packaged = serverEntry({ packaged: true, appPath: join(resourcesPath, 'app.asar'), resourcesPath })
    expect(packaged).toBe(join(resourcesPath, 'server', 'server.mjs'))
    // Electron loads resources/app as an app, so the server never sits there.
    expect(packaged.split(sep)).not.toContain('app')
  })

  test('builds the server env', () => {
    const input: NodeJS.ProcessEnv = {
      Path: 'C:\\bin',
      OPEN_AFLOW_CONFIG_DIR: 'C:\\cfg',
      OPEN_AFLOW_API_PORT: '3110',
      OPEN_AFLOW_PARENT_PID: '1',
      open_aflow_parent_pid: '2',
      ELECTRON_RUN_AS_NODE: '1',
      electron_run_as_node: '1',
      Electron_Run_As_Node: '',
    }
    const before = { ...input }

    const env = serverEnv(input, 4242)

    expect(env).toEqual({ Path: 'C:\\bin', OPEN_AFLOW_CONFIG_DIR: 'C:\\cfg', OPEN_AFLOW_API_PORT: '3110', OPEN_AFLOW_PARENT_PID: '4242' })
    expect(input).toEqual(before)
    expect(env).not.toBe(input)
  })

  test('sets the parent ID when none was set', () => {
    expect(serverEnv({}, 7)).toEqual({ OPEN_AFLOW_PARENT_PID: '7' })
  })
})
