CREATE TABLE IF NOT EXISTS outreach_settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
    default_timezone TEXT NOT NULL DEFAULT 'UTC',
    default_send_start_time TEXT NOT NULL DEFAULT '09:00',
    default_send_end_time TEXT NOT NULL DEFAULT '17:00',
    send_on_weekends BOOLEAN NOT NULL DEFAULT FALSE,
    track_opens BOOLEAN NOT NULL DEFAULT TRUE,
    track_clicks BOOLEAN NOT NULL DEFAULT TRUE,
    default_daily_limit INTEGER NOT NULL DEFAULT 50,
    default_min_minutes_between_emails INTEGER NOT NULL DEFAULT 5,
    warmup_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    warmup_days INTEGER NOT NULL DEFAULT 21,
    notify_on_reply BOOLEAN NOT NULL DEFAULT TRUE,
    notify_on_bounce BOOLEAN NOT NULL DEFAULT TRUE,
    notify_on_unsubscribe BOOLEAN NOT NULL DEFAULT FALSE,
    weekly_report BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE outreach_settings ENABLE ROW LEVEL SECURITY;
