-- Migration 023: system_integrations table for Telegram alert config
CREATE TABLE IF NOT EXISTS system_integrations (
    id TEXT PRIMARY KEY DEFAULT 'default',
    telegram_bot_token TEXT,
    telegram_chat_id TEXT,
    telegram_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Insert default row if not exists
INSERT INTO system_integrations (id) VALUES ('default') ON CONFLICT DO NOTHING;

-- RLS
ALTER TABLE system_integrations ENABLE ROW LEVEL SECURITY;
