export function serverEntry(_o: { packaged: boolean; appPath: string; resourcesPath: string }): string {
  return ''
}

export function serverEnv(env: NodeJS.ProcessEnv, _mainPid: number): NodeJS.ProcessEnv {
  return env
}
