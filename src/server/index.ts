import 'dotenv/config'
// Must stay second: it isolates the development process from real mail and external servers.
import './lib/dev-guard-entry'
import { startSelectedRuntime } from './runtime-entry'

// Select before importing any mail/jobs/integrations/legacy Auth module.
export const startup = startSelectedRuntime()
void startup.catch(() => {
    console.error('Xmail startup failed; configuration or dependency unavailable.')
    process.exitCode = 1
})
