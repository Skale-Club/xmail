export const APP_CONSTANTS = {
    MOBILE_BREAKPOINT: 1024,
    TABLET_BREAKPOINT: 768,
    
    EMAIL: {
        DEFAULT_PAGE_SIZE: 30,
        MAX_PAGE_SIZE: 100,
        INFINITE_SCROLL_THRESHOLD: 200,
        DEBOUNCE_MS: 300,
        MIN_SEARCH_LENGTH: 2
    },
    
    RATE_LIMIT: {
        MAX_REQUESTS: 100,
        WINDOW_MS: 15 * 60 * 1000
    },
    
    STORAGE: {
        SELECTED_MAILBOX_KEY: 'selectedMailboxId',
        SELECTED_MAILBOX_KEY_PREFIX: 'selectedMailboxId:',
        THEME_KEY: 'theme',
        SIDEBAR_STATE_KEY: 'sidebarOpen'
    },
    
    DATE_FORMATS: {
        DISPLAY: 'MMM d, yyyy',
        DISPLAY_WITH_TIME: 'MMM d, yyyy h:mm a',
        TIME_ONLY: 'h:mm a',
        ISO: "yyyy-MM-dd'T'HH:mm:ss.SSSxxx"
    },
    
    AVATAR: {
        COLORS: [
            'bg-red-500',
            'bg-orange-500',
            'bg-amber-500',
            'bg-yellow-500',
            'bg-lime-500',
            'bg-green-500',
            'bg-emerald-500',
            'bg-teal-500',
            'bg-cyan-500',
            'bg-sky-500',
            'bg-blue-500',
            'bg-indigo-500',
            'bg-violet-500',
            'bg-purple-500',
            'bg-fuchsia-500',
            'bg-pink-500',
            'bg-rose-500'
        ]
    },
    
    EMAIL_PROVIDERS: {
        GMAIL: 'gmail',
        OUTLOOK: 'outlook',
        YAHOO: 'yahoo',
        ICLOUD: 'icloud',
        CUSTOM: 'custom'
    }
} as const

export function getSelectedMailboxStorageKey(sessionId: string | null | undefined): string {
    return `${APP_CONSTANTS.STORAGE.SELECTED_MAILBOX_KEY_PREFIX}${sessionId || 'anonymous'}`
}

export const PROVIDER_CONFIG = {
    gmail: {
        name: 'Gmail',
        color: 'bg-red-500',
        icon: 'G'
    },
    outlook: {
        name: 'Outlook',
        color: 'bg-blue-500',
        icon: 'O'
    },
    yahoo: {
        name: 'Yahoo Mail',
        color: 'bg-purple-500',
        icon: 'Y'
    },
    icloud: {
        name: 'iCloud',
        color: 'bg-gray-500',
        icon: 'i'
    },
    custom: {
        name: 'Custom',
        color: 'bg-gray-600',
        icon: '@'
    }
} as const

export const FOLDER_LABELS: Record<string, string> = {
    inbox: 'Inbox',
    sent: 'Sent',
    drafts: 'Drafts',
    trash: 'Trash',
    starred: 'Starred',
    archive: 'Archive',
    spam: 'Spam'
}

export const DATE_RANGE_OPTIONS = {
    all: 'Any time',
    today: 'Today',
    week: 'Last 7 days',
    month: 'Last 30 days',
    year: 'Last year'
} as const
