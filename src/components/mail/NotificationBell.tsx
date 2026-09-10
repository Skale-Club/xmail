import { Bell, X, AlertTriangle, Mail, Info } from 'lucide-react'
import { useNotifications, useUnreadCount, useMarkAsRead, useMarkAllAsRead, useDeleteNotification, UserNotification } from '../../hooks/useNotifications'
import { cn } from '../../lib/utils'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '../ui/dropdown-menu'

function getNotificationIcon(type: string) {
    switch (type) {
        case 'bounce':
            return <AlertTriangle className="w-4 h-4 text-amber-500" />
        case 'held':
            return <Mail className="w-4 h-4 text-orange-500" />
        case 'spam_alert':
            return <AlertTriangle className="w-4 h-4 text-red-500" />
        case 'quota_exceeded':
        case 'limit_reached':
            return <AlertTriangle className="w-4 h-4 text-red-500" />
        default:
            return <Info className="w-4 h-4 text-blue-500" />
    }
}

function formatRelativeTime(dateString: string): string {
    const date = new Date(dateString)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMins / 60)
    const diffDays = Math.floor(diffHours / 24)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    return date.toLocaleDateString()
}

interface NotificationItemProps {
    notification: UserNotification
    onMarkRead: (id: string) => void
    onDelete: (id: string) => void
}

function NotificationItem({ notification, onMarkRead, onDelete }: NotificationItemProps) {
    return (
        <div
            className={cn(
                'flex items-start gap-3 p-3 hover:bg-accent transition-colors cursor-pointer border-b border-border last:border-0',
                !notification.read && 'bg-muted/50'
            )}
            onClick={() => !notification.read && onMarkRead(notification.id)}
        >
            <div className="mt-0.5">{getNotificationIcon(notification.type)}</div>
            <div className="flex-1 min-w-0">
                <p className={cn('text-sm font-medium truncate', !notification.read && 'font-semibold')}>
                    {notification.title}
                </p>
                <p className="text-xs text-muted-foreground line-clamp-2">{notification.message}</p>
                <p className="text-xs text-muted-foreground mt-1">{formatRelativeTime(notification.createdAt)}</p>
            </div>
            <button
                onClick={(e) => {
                    e.stopPropagation()
                    onDelete(notification.id)
                }}
                className="p-1 hover:bg-destructive/10 rounded text-muted-foreground hover:text-destructive"
            >
                <X className="w-3 h-3" />
            </button>
        </div>
    )
}

export function NotificationBell() {
    const { data: unreadData } = useUnreadCount()
    const { data: notificationsData, isLoading } = useNotifications(1, 10)
    const markAsRead = useMarkAsRead()
    const markAllAsRead = useMarkAllAsRead()
    const deleteNotification = useDeleteNotification()

    const unreadCount = unreadData?.unreadCount || 0
    const notifications = notificationsData?.data || []

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    className="relative p-2 rounded-xl hover:bg-accent hover:text-accent-foreground text-muted-foreground transition-colors"
                    aria-label="Notifications"
                >
                    <Bell className="w-5 h-5" />
                    {unreadCount > 0 && (
                        <span className="absolute top-1 right-1 w-2 h-2 bg-destructive rounded-full animate-pulse" />
                    )}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80 max-h-96 p-0 overflow-hidden">
                <div className="flex items-center justify-between p-3 border-b border-border">
                    <h3 className="font-semibold text-sm">Notifications</h3>
                    {unreadCount > 0 && (
                        <button
                            onClick={() => markAllAsRead.mutate()}
                            disabled={markAllAsRead.isPending}
                            className="text-xs text-primary hover:underline disabled:opacity-50"
                        >
                            Mark all read
                        </button>
                    )}
                </div>

                <div className="overflow-y-auto max-h-80">
                    {isLoading ? (
                        <div className="p-4 text-center text-muted-foreground text-sm">
                            Loading...
                        </div>
                    ) : notifications.length === 0 ? (
                        <div className="p-4 text-center text-muted-foreground text-sm">
                            No notifications
                        </div>
                    ) : (
                        notifications.map((notification) => (
                            <NotificationItem
                                key={notification.id}
                                notification={notification}
                                onMarkRead={(id) => markAsRead.mutate(id)}
                                onDelete={(id) => deleteNotification.mutate(id)}
                            />
                        ))
                    )}
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    )
}