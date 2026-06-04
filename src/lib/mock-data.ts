import { EmailItem } from '../components/mail/EmailList'
import { EmailThread } from './email-threading'

export function createMockInboxEmails(applicationName: string, companyName: string): EmailItem[] {
    const domain = companyName ? `${companyName.toLowerCase().replace(/\s+/g, '')}.com` : 'example.com'

    return [
        {
            id: '1',
            subject: `Welcome to ${applicationName}!`,
            snippet: 'Get started with your new email account and explore all the features we have prepared for you.',
            from: { name: `${companyName || 'Platform'} Team`, email: `noreply@${domain}` },
            to: [{ name: 'User', email: `user@${domain}` }],
            date: new Date(),
            read: false,
            starred: true,
            hasAttachments: false,
            labels: ['Welcome']
        },
        {
            id: '2',
            subject: 'Meeting Tomorrow at 10 AM',
            snippet: 'Hi team, just a reminder about our weekly sync meeting tomorrow at 10 AM. Please come prepared with your updates.',
            from: { name: 'John Smith', email: 'john.smith@company.com' },
            to: [{ name: 'User', email: `user@${domain}` }],
            date: new Date(Date.now() - 3600000),
            read: false,
            starred: false,
            hasAttachments: true,
            labels: ['Work']
        },
        {
            id: '3',
            subject: 'Your Monthly Report is Ready',
            snippet: 'Your analytics report for January 2024 is now available. Click here to view the detailed breakdown.',
            from: { name: 'Analytics Team', email: 'reports@analytics.com' },
            to: [{ name: 'User', email: `user@${domain}` }],
            date: new Date(Date.now() - 86400000),
            read: true,
            starred: false,
            hasAttachments: true
        },
        {
            id: '4',
            subject: 'Re: Project Update',
            snippet: 'Thanks for the update! I have reviewed the changes and everything looks good. Lets proceed with the deployment.',
            from: { name: 'Sarah Johnson', email: 'sarah.j@startup.io' },
            to: [{ name: 'User', email: `user@${domain}` }],
            date: new Date(Date.now() - 172800000),
            read: true,
            starred: false,
            hasAttachments: false
        },
        {
            id: '5',
            subject: 'New Feature Announcement',
            snippet: 'We are excited to announce our latest feature: Email Templates! Create and manage your email templates with ease.',
            from: { name: 'Product Team', email: `product@${domain}` },
            to: [{ name: 'User', email: `user@${domain}` }],
            date: new Date(Date.now() - 259200000),
            read: true,
            starred: false,
            hasAttachments: false
        }
    ]
}

export const mockSentEmails: EmailItem[] = [
    {
        id: 's1',
        subject: 'Re: Project Update',
        snippet: 'Thanks for the update! I have reviewed the changes and everything looks good.',
        from: { name: 'You', email: 'user@example.com' },
        to: [{ name: 'Sarah Johnson', email: 'sarah.j@startup.io' }],
        date: new Date(Date.now() - 3600000),
        read: true,
        starred: false,
        hasAttachments: false
    },
    {
        id: 's2',
        subject: 'Weekly Status Report',
        snippet: 'Please find attached my weekly status report for your review.',
        from: { name: 'You', email: 'user@example.com' },
        to: [{ name: 'Manager', email: 'manager@company.com' }],
        date: new Date(Date.now() - 86400000),
        read: true,
        starred: true,
        hasAttachments: true
    },
    {
        id: 's3',
        subject: 'Meeting Notes - Q4 Planning',
        snippet: 'Hi team, here are the notes from our Q4 planning session yesterday.',
        from: { name: 'You', email: 'user@example.com' },
        to: [{ name: 'Team', email: 'team@company.com' }],
        date: new Date(Date.now() - 172800000),
        read: true,
        starred: false,
        hasAttachments: false
    }
]

export const mockDraftEmails: EmailItem[] = [
    {
        id: 'd1',
        subject: 'Draft: Follow up on our call',
        snippet: 'Hi, I wanted to follow up on our conversation earlier today about the new project...',
        from: { name: 'You', email: 'user@skaleclub.com' },
        to: [{ name: 'Client', email: 'client@example.com' }],
        date: new Date(Date.now() - 3600000),
        read: true,
        starred: false,
        hasAttachments: false
    },
    {
        id: 'd2',
        subject: 'Draft: Meeting request',
        snippet: 'Hi team, I would like to schedule a meeting to discuss the upcoming quarterly...',
        from: { name: 'You', email: 'user@skaleclub.com' },
        to: [{ name: 'Team', email: 'team@company.com' }],
        date: new Date(Date.now() - 86400000),
        read: true,
        starred: false,
        hasAttachments: false
    }
]

export const mockTrashEmails: EmailItem[] = [
    {
        id: 't1',
        subject: 'Old Newsletter',
        snippet: 'Check out our latest updates and news from last month...',
        from: { name: 'Newsletter', email: 'newsletter@spam.com' },
        to: [{ name: 'You', email: 'user@example.com' }],
        date: new Date(Date.now() - 604800000),
        read: true,
        starred: false,
        hasAttachments: false
    }
]

export const mockStarredEmails: EmailItem[] = [
    {
        id: 'st1',
        subject: 'Important: Q4 Planning Document',
        snippet: 'Please review the attached Q4 planning document before our meeting tomorrow...',
        from: { name: 'Sarah Johnson', email: 'sarah.j@startup.io' },
        to: [{ name: 'You', email: 'user@example.com' }],
        date: new Date(Date.now() - 3600000),
        read: false,
        starred: true,
        hasAttachments: true,
        labels: ['Work', 'Important']
    },
    {
        id: 'st2',
        subject: 'Re: Contract Review',
        snippet: 'Thanks for sending over the contract. I have reviewed it and made some annotations...',
        from: { name: 'Legal Team', email: 'legal@company.com' },
        to: [{ name: 'You', email: 'user@example.com' }],
        date: new Date(Date.now() - 86400000),
        read: true,
        starred: true,
        hasAttachments: true,
        labels: ['Legal']
    },
    {
        id: 'st3',
        subject: 'Vacation Request Approved',
        snippet: 'Your vacation request for December 20-27 has been approved. Enjoy your time off!',
        from: { name: 'HR Department', email: 'hr@company.com' },
        to: [{ name: 'You', email: 'user@example.com' }],
        date: new Date(Date.now() - 172800000),
        read: true,
        starred: true,
        hasAttachments: false
    },
    {
        id: 'st4',
        subject: 'Customer Feedback - Excellent Service',
        snippet: 'I wanted to share some great feedback we received from a customer about your recent support...',
        from: { name: 'Manager', email: 'manager@company.com' },
        to: [{ name: 'You', email: 'user@example.com' }],
        date: new Date(Date.now() - 259200000),
        read: true,
        starred: true,
        hasAttachments: false
    }
]

export const mockEmailDetails: Record<string, {
    subject: string
    body: string
    from: { name: string; email: string }
    to: { name: string; email: string }[]
    date: Date
    starred: boolean
    attachments?: { name: string; size: string; type: string }[]
}> = {
    '1': {
        subject: 'Welcome to Xmail!',
        body: `Dear User,

Thank you for using Xmail! We are thrilled to have you as part of our growing community.

Here's what you can do with your new email account:

1. Send and receive emails professionally
2. Organize your inbox with folders and labels
3. Track email opens and clicks
4. Create email templates for faster composing
5. Set up webhooks for automated workflows

If you have any questions or need assistance, don't hesitate to reach out to our support team.

Best regards,
The Skale Club Team

---
Xmail - Professional Email Made Simple
Website: https://skaleclub.com
Support: support@skaleclub.com`,
        from: { name: 'Skale Club Team', email: 'noreply@skaleclub.com' },
        to: [{ name: 'User', email: 'user@skaleclub.com' }],
        date: new Date(),
        starred: true,
        attachments: [
            { name: 'getting-started.pdf', size: '245 KB', type: 'pdf' },
            { name: 'welcome-guide.pdf', size: '1.2 MB', type: 'pdf' }
        ]
    },
    '2': {
        subject: 'Meeting Tomorrow at 10 AM',
        body: `Hi team,

Just a reminder about our weekly sync meeting tomorrow at 10 AM. Please come prepared with your updates.

Agenda:
1. Sprint review
2. Blockers discussion
3. Planning for next week

See you there!

Best,
John`,
        from: { name: 'John Smith', email: 'john.smith@company.com' },
        to: [{ name: 'User', email: 'user@skaleclub.com' }],
        date: new Date(Date.now() - 3600000),
        starred: false
    }
}

export const mockThreads: Record<string, EmailThread> = {
    'thread-1': {
        threadId: 'thread-1',
        subject: 'Project Discussion',
        messages: [
            {
                id: 'msg-1',
                from: { name: 'John Smith', email: 'john@company.com' },
                to: [{ name: 'Team', email: 'team@company.com' }],
                date: new Date(Date.now() - 86400000),
                subject: 'Project Discussion',
                body: 'Hi team,\n\nI wanted to start a discussion about our upcoming project. We have two options:\n\n1. Build from scratch\n2. Use existing framework\n\nWhat do you think?',
                snippet: 'I wanted to start a discussion about our upcoming project...',
                read: true,
                starred: false,
                messageId: 'msg-1'
            },
            {
                id: 'msg-2',
                from: { name: 'Sarah Johnson', email: 'sarah@company.com' },
                to: [{ name: 'Team', email: 'team@company.com' }],
                date: new Date(Date.now() - 43200000),
                subject: 'Re: Project Discussion',
                body: 'Hi John,\n\nI think option 2 would be faster, but option 1 gives us more flexibility.\n\nLet\'s discuss in our next meeting.\n\nSarah',
                snippet: 'I think option 2 would be faster, but option 1 gives us more flexibility...',
                read: true,
                starred: false,
                inReplyTo: 'msg-1',
                messageId: 'msg-2'
            },
            {
                id: 'thread-1',
                from: { name: 'User', email: 'user@skaleclub.com' },
                to: [{ name: 'Team', email: 'team@company.com' }],
                date: new Date(Date.now() - 7200000),
                subject: 'Re: Project Discussion',
                body: 'Thanks for the input!\n\nI agree with Sarah. Let\'s go with option 2 for the MVP and consider option 1 for the next version.\n\nI\'ll schedule a meeting for tomorrow.',
                snippet: 'Thanks for the input! I agree with Sarah...',
                read: false,
                starred: false,
                inReplyTo: 'msg-2',
                messageId: 'thread-1'
            }
        ],
        participants: [
            { name: 'John Smith', email: 'john@company.com' },
            { name: 'Sarah Johnson', email: 'sarah@company.com' },
            { name: 'User', email: 'user@skaleclub.com' }
        ],
        lastMessageAt: new Date(Date.now() - 7200000),
        unreadCount: 1,
        starred: false,
        hasAttachments: false
    }
}
