// SPIKE ONLY. `npx tsx spike/package.ts`: a `dir` build of the spike app in release-spike/ (Linux or Windows, x64).
// node-pty (and koffi, on Windows) sit in resources/native as real files outside the asar, because a native .node
// file can't load from inside an asar. Only this platform's prebuilt binaries are copied.
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Arch, build, Platform } from 'electron-builder'
import manifest from '../package.json' with { type: 'json' }

const WIN = process.platform === 'win32'
const pkg = join(dirname(fileURLToPath(import.meta.url)), '..')
const real = (p: string) => realpathSync(join(pkg, p))
const pty = real('node_modules/node-pty')
const plat = WIN ? 'win32-x64' : 'linux-x64'
const native = [
  { from: pty, to: 'native/node_modules/node-pty', filter: ['package.json', 'lib/**/*.js', `prebuilds/${plat}/**/*`, '!**/*.pdb', '!**/*.test.js'] },
  ...(WIN ? [{ from: real('node_modules/koffi'), to: 'native/node_modules/koffi', filter: ['package.json', 'index.js', 'indirect.js', 'build/koffi/win32_x64/koffi.node'] }] : []),
]
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
const files = await build({
  projectDir: pkg,
  publish: 'never',
  targets: (WIN ? Platform.WINDOWS : Platform.LINUX).createTarget('dir', Arch.x64),
  config: {
    appId: 'com.alvionlabs.openaflow.spike',
    productName: 'OpenAFlowSpike',
    electronVersion: manifest.devDependencies.electron,
    directories: { output: 'release-spike', buildResources: 'build' },
    extraMetadata: { name: 'openaflow-spike', main: 'dist-spike/spike-main.cjs' },
    files: ['dist-spike/**/*', 'assets/tray.png', 'package.json', '!node_modules/**/*'],
    extraResources: [{ from: '../server/dist/app', to: 'server' }, ...native],
    npmRebuild: false,
    nodeGypRebuild: false,
    linux: { target: 'dir', executableName: 'openaflow-spike' },
    win: { target: 'dir', executableName: 'openaflow-spike', signAndEditExecutable: false },
  },
})
console.log(`spike: packaged\n${files.join('\n')}`)
