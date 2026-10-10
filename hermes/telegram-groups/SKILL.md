---
name: telegram-groups
description: "Load when the owner wants Hermes in a new Telegram group, asks why Hermes ignores a group, wants a cron delivered to a group, or mentions chat ids, allowed_chats or the bot being admin."
metadata:
  hermes:
    tags: [telegram, gateway, groups, operations]
    related_skills: [stuscle-fairs, active-prospect-system]
---

# Telegram groups

You reach Telegram through the gateway as the bot `@skaleclubhermesbot`. Your config is
`/opt/data/config.yaml`. The bot token is in the env var `TELEGRAM_BOT_TOKEN`; never print it.
The owner (Vanildo) talks to you in Brazilian Portuguese. Reply to him in Portuguese.

## Why a group can be silent: two gates

A group message reaches you only when BOTH are true:

1. **Telegram delivers it.** In a group a bot is in privacy mode: it only receives `/commands`, replies to its
   own messages and @mentions. The owner must make the bot a group **administrator** (no permissions need to be
   on) for normal messages to arrive.
2. **The gateway accepts the chat.** `telegram.allowed_chats` in `config.yaml` is a whitelist. Group messages
   from a chat not on it are dropped silently: you never see them and nothing is logged. DMs are not filtered.
   The list is read only when the gateway starts.

So if the owner says "I added you to the group and you don't answer", you cannot see that group's messages at
all. He will be telling you in DM or in another allowed chat. Check the two gates; don't guess.

## Adding a new group (owner asks in DM)

1. Ask for the group's chat id if he does not give it. A web.telegram.org link like
   `https://web.telegram.org/k/#-5496280561` has it after `#`. Basic groups are `-5…`; supergroups are `-100…`.
2. Check the chat and your role (read-only calls, safe while the gateway runs):
   ```
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getChat?chat_id=<ID>"
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getMe"        # your bot user id
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getChatMember?chat_id=<ID>&user_id=<bot id>"
   ```
   - `getChatMember` status must be `administrator`. If it is `member`, ask him to promote the bot.
   - If `getChat` returns `migrate_to_chat_id`, the group became a supergroup. Use the new `-100…` id.
   - **Never call `getUpdates`.** It steals updates from the running gateway.
3. Read the current whitelist: `grep -n allowed_chats /opt/data/config.yaml`.
   `hermes config set` REPLACES the value, so the new value must contain every existing id plus the new one.
4. Only after the owner confirms he wants this group added, run
   `hermes config set telegram.allowed_chats "<all existing ids>,<new id>"`
   and read the file again to confirm the full list is there.
5. The change applies only after a gateway restart. **Do not restart yourself.** It would cut the conversation
   and any running cron job. Tell the owner the change is saved and needs a restart from the server
   (`cd /opt/hermes && docker compose restart hermes`), which he or Claude Code can do.
6. After the restart, ask him to send a message in the group. If you receive it, done.

## Rules

- **Never run or suggest `/sethome` inside a group.** It moves your home channel, where ops alerts and default
  cron deliveries go, away from the owner's DM.
- Cron delivery to a group: `--deliver telegram:<chat_id>`. Posting only needs the bot to be a member; receiving
  needs both gates. If a group migrates to a supergroup, every cron delivering there must be edited to the new id.
- Each group is a separate session with its own context. Something said in one group is not visible in another
  or in the DM.
- Never remove an id from `allowed_chats` unless the owner names that chat and asks for it.

## Known chats (2026-10-10)

| Chat id | What |
|---|---|
| `5209892068` | Owner's DM, home channel |
| `8664810189` | DM from the "Skale Club" Telegram account |
| `-5433207263`, `-5265942843` | Older groups |
| `-5496280561` | "Hermes \| Faires": Stuscle fair radar (skill `stuscle-fairs`, cron `stuscle-fairs-radar`) |

When a new chat is added, ask the owner to have this table updated in the repo copy
(`hermes/telegram-groups/SKILL.md` in the xmail repository), not only on the server.
