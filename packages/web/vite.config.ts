import { homedir } from 'node:os'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { DEFAULT_API_PORT, liveConfigDir, portFromEnv } from '@openaflow/server/config'
import { tokenMetaPlugin } from '@openaflow/server/session-token'

const apiPort = portFromEnv(process.env, 'OPENAFLOW_API_PORT', DEFAULT_API_PORT)
const webPort = portFromEnv(process.env, 'OPENAFLOW_WEB_PORT', 3001)
// No other page may frame the board: a framed page's own token and Origin pass the guards, so a click
// there would count. Production sends the same pair from web-app.ts.
const NO_FRAMING = { 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' }

export default defineConfig({
  // The API writes its session token in its config folder. Each page load asks the server's own rule which
  // folder that is, so a start whose old-folder copy failed still gets its token in the page.
  plugins: [react(), tokenMetaPlugin(() => liveConfigDir(process.env, process.platform, homedir()))],
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    // Vite's default CORS lets any localhost origin read responses, the proxied API's
    // included. The board is same-origin only: no response carries Access-Control-Allow-*.
    cors: false,
    headers: NO_FRAMING,
    proxy: { '/api': `http://127.0.0.1:${apiPort}` },
  },
  preview: { host: '127.0.0.1', port: webPort, strictPort: true, cors: false, headers: NO_FRAMING },
})
