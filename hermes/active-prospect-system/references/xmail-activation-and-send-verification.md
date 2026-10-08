# Xmail activation and send verification

Use this procedure whenever a draft campaign is being launched through the formal Xmail approval flow.

## Approval delivery

- Request activation with the formal Xmail approval tool. Ordinary chat authorization is not the executable approval.
- The approval card is delivered by `xmailoppsbot`, which is a separate Telegram conversation from the Hermes bot.
- Vanildo may have more than one connected Telegram account. Do not promise that the card will appear in the current chat. Say which bot to open; if account routing is uncertain, inspect available Telegram targets and explain the distinction.
- Do not create duplicate approval requests while an existing request remains pending. Read the existing approval first.
- After Vanildo presses the button, poll the approval status before diagnosing failure. The callback can arrive just after an initial read. Treat only `executed` as completed activation.

## Scope of recurring approval

- Every new campaign requires formal approval for its first activation.
- Approval is not repeated for each email or each scheduled follow-up in that active campaign.
- A campaign previously activated through approval and later paused by Hermes may be resumed without a new approval only when Xmail's readiness checks allow it.
- A campaign paused by a person, a bounce/unsubscribe guardrail, or one never formally approved requires a new activation approval.

## Verify activation separately from sending

Activation and delivery are asynchronous and must be verified as separate facts:

1. Read the approval until it is `executed`.
2. Read the campaign and confirm `status: active`, `activatedThroughApproval: true`, and no pending approval.
3. Do not claim an email was sent merely because the campaign became active.
4. Inbox fields such as `sentToday` or `lastSentAt` may update before campaign attribution. Treat them as preliminary activity, not recipient-level proof.
5. Poll the campaign and campaign leads until the campaign reports a sent email and the intended lead reports `status: contacted` with `lastEvent.type: email_sent`.
6. Report the exact confirmed recipient and the remaining leads' scheduled state. Respect inbox spacing; do not force parallel sends to make the UI look immediate.
7. Check for bounce, unsubscribe, reply, or exclusion events before describing the launch as clean.

The core reporting rule is: **approval requested is not activation, activation is not delivery, and inbox activity is not recipient-level proof.**
