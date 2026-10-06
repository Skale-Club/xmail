import React from 'react'
import { Link } from 'wouter'
import { AlertTriangle, PauseCircle, PlayCircle, ShieldCheck, Sparkles } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { Button } from '../../ui/button'
import { cn } from '../../../lib/utils'
import type { OrgAiAutomationSettings } from '../../../lib/unified-inbox-api'

// ============================================================
// AI automation status chip (inbox header)
// ============================================================
// Shows at a glance what the AI may do in this organization and lets the operator pause/resume
// without leaving the inbox. PRESENTATIONAL: the container (`useOrgAiAutomation`) wires the real
// state and the same actions Settings uses. Text always accompanies the icon (never colour alone).

type ChipTone = 'off' | 'drafts' | 'active' | 'paused' | 'blocked'

export interface ChipState {
    tone: ChipTone
    label: string
    description: string
    icon: React.ReactNode
    className: string
}

const ICON = 'h-3.5 w-3.5 shrink-0'

export function describeAiAutomation(settings: OrgAiAutomationSettings): ChipState {
    if (settings.autonomousEnabled) {
        if (settings.autonomyPaused) {
            return {
                tone: 'paused',
                label: 'Automation paused',
                description: `No automatic replies go out until you resume.${settings.autonomyPausedReason ? ` Reason: ${settings.autonomyPausedReason}.` : ''}`,
                icon: <PauseCircle className={ICON} aria-hidden="true" />,
                className: 'border-amber-500/50 bg-amber-500/10 text-amber-800 dark:text-amber-300',
            }
        }
        if (!settings.outreachEnabled) {
            return {
                tone: 'blocked',
                label: 'Automation blocked',
                description: 'Outreach sending is disabled for this organization, so the AI cannot reply on its own.',
                icon: <AlertTriangle className={ICON} aria-hidden="true" />,
                className: 'border-red-500/50 bg-red-500/10 text-red-700 dark:text-red-300',
            }
        }
        return {
            tone: 'active',
            label: 'Automation on',
            description: 'The AI replies on its own in campaigns that also opted in. Every send still passes the same suppression, limit and warm-up checks.',
            icon: <ShieldCheck className={ICON} aria-hidden="true" />,
            className: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300',
        }
    }
    if (settings.draftAssistanceEnabled) {
        return {
            tone: 'drafts',
            label: 'AI suggestions on',
            description: 'The AI suggests drafts for you to review. It never sends on its own.',
            icon: <Sparkles className={ICON} aria-hidden="true" />,
            className: 'border-border bg-muted text-foreground',
        }
    }
    return {
        tone: 'off',
        label: 'AI off',
        description: 'Draft suggestions and automatic replies are turned off.',
        icon: <Sparkles className={ICON} aria-hidden="true" />,
        className: 'border-border bg-background text-muted-foreground',
    }
}

export interface AiAutomationChipProps {
    settings: OrgAiAutomationSettings | undefined
    isLoading?: boolean
    /** Admin or member. Viewers only see the state. */
    canManage: boolean
    onPause: (reason?: string) => void
    onResume: () => void
    pending?: boolean
    error?: string | null
    /** Icon only (collapsed rail). The text stays available to assistive tech. */
    compact?: boolean
    className?: string
}

export function AiAutomationChip({
    settings,
    isLoading,
    canManage,
    onPause,
    onResume,
    pending,
    error,
    compact,
    className,
}: AiAutomationChipProps) {
    const [reason, setReason] = React.useState('')

    if (isLoading || !settings) {
        return <span className={cn('h-7 w-28 animate-pulse rounded-full bg-muted', compact && 'w-7', className)} aria-hidden="true" />
    }

    const state = describeAiAutomation(settings)
    const canPause = canManage && state.tone === 'active'
    const canResume = canManage && state.tone === 'paused'

    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    title={state.label}
                    aria-label={`AI status: ${state.label}`}
                    className={cn(
                        'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        state.className,
                        compact && 'w-7 justify-center px-0',
                        className,
                    )}
                >
                    {state.icon}
                    {!compact && <span className="truncate">{state.label}</span>}
                </button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 space-y-3 p-3 text-xs">
                <div>
                    <p className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                        {state.icon}
                        {state.label}
                    </p>
                    <p className="mt-1 text-muted-foreground">{state.description}</p>
                </div>

                {canPause && (
                    <div className="space-y-2">
                        <label htmlFor="inbox-ai-pause-reason" className="block text-muted-foreground">Pause reason (optional)</label>
                        <input
                            id="inbox-ai-pause-reason"
                            type="text"
                            value={reason}
                            maxLength={200}
                            onChange={(e) => setReason(e.target.value)}
                            placeholder="e.g. reviewing recent replies"
                            className="w-full rounded border border-border bg-background px-2 py-1.5 text-sm"
                        />
                        <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={pending}
                            onClick={() => { onPause(reason.trim() || undefined); setReason('') }}
                        >
                            <PauseCircle className="mr-1.5 h-4 w-4" aria-hidden="true" /> Pause automation
                        </Button>
                    </div>
                )}

                {canResume && (
                    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={() => onResume()}>
                        <PlayCircle className="mr-1.5 h-4 w-4" aria-hidden="true" /> Resume automation
                    </Button>
                )}

                {error && <p role="alert" className="text-red-600 dark:text-red-400">{error}</p>}
                {!canManage && <p className="italic text-muted-foreground">You have read-only access to these controls.</p>}

                <Link
                    href="/outreach/settings"
                    className="inline-block font-medium text-foreground underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                    Open AI settings
                </Link>
            </PopoverContent>
        </Popover>
    )
}

export default AiAutomationChip
