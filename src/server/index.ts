import 'dotenv/config'
import { startSelectedRuntime } from './runtime-entry'

// Select before importing any mail/jobs/integrations/legacy Auth module.
export const startup = startSelectedRuntime()
void startup.catch(() => {
    console.error('Xmail startup failed; configuration or dependency unavailable.')
    process.exitCode = 1
})
