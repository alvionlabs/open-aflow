// SPIKE ONLY. `npx tsx spike/package.ts`: a Linux `dir` build of the spike app in release-spike/. node-pty sits in
// resources/native (real files, outside the asar), because a native .node file can't load from inside an asar.
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Arch, build, Platform } from 'electron-builder'
import manifest from '../package.json' with { type: 'json' }

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const real = (p: string) => realpathSync(join(pkg, p))
const pty = real('node_modules/@lydell/node-pty')
const ptyLinux = realpathSync(join(pty, '..', 'node-pty-linux-x64'))
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
const files = await build({
  projectDir: pkg,
  publish: 'never',
  targets: Platform.LINUX.createTarget('dir', Arch.x64),
  config: {
    appId: 'com.alvionlabs.openaflow.spike',
    productName: 'OpenAFlowSpike',
    electronVersion: manifest.devDependencies.electron,
    directories: { output: 'release-spike', buildResources: 'build' },
    extraMetadata: { name: 'openaflow-spike', main: 'dist-spike/spike-main.cjs' },
    files: ['dist-spike/**/*', 'assets/tray.png', 'package.json', '!node_modules/**/*'],
    extraResources: [
      { from: '../server/dist/app', to: 'server' },
      { from: pty, to: 'native/node_modules/@lydell/node-pty', filter: ['**/*', '!**/*.d.ts'] },
      { from: ptyLinux, to: 'native/node_modules/@lydell/node-pty-linux-x64' },
    ],
    npmRebuild: false,
    nodeGypRebuild: false,
    linux: { target: 'dir', executableName: 'openaflow-spike' },
  },
})
console.log(`spike: packaged\n${files.join('\n')}`)
