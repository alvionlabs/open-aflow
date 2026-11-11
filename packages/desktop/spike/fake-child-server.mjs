// SPIKE ONLY. A dev server stand-in: `node fake-child-server.mjs <port> <marker>`. The marker is in argv so pgrep -f finds it.
import { createServer } from 'node:http'
const port = Number(process.argv[2])
createServer((_q, s) => s.end('ok')).listen(port, '127.0.0.1')
process.on('SIGHUP', () => {}) // like nohup
