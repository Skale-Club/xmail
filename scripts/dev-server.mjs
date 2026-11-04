import 'dotenv/config'
import { spawn } from 'node:child_process'

// Force development even when the parent shell or .env contains NODE_ENV=production.
const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'watch', 'src/server/index.ts'], {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'development' },
})
child.on('error', () => { process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
