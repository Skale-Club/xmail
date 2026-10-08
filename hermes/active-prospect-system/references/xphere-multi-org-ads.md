# Xphere multi-org ads operations

Use this procedure whenever an ads account may live outside the organization bound to the default Xphere token.

## Organization and platform preflight

1. Treat every `xph_` token as organization-scoped. An account in another Xphere organization is invisible through the current token even if the same operator owns both organizations.
2. Use a separately named MCP server for each organization, such as `xphere` and `xphere_bigode`. Never overwrite the default organization credential to reach another tenant.
3. Select the platform from the requested account/campaign before searching. A Google Ads customer ID must be queried with Google Ads tools, not by scanning Meta accounts.
4. On the selected MCP server, call `ads_list_connections(platform=...)` first and verify the exact account ID, name, status, and connection error. Then query campaigns on that account.
5. `account_not_found` means the account does not match the active organization/account policy. It is not evidence that Xphere is down. After one such response, inspect `available_accounts` and the MCP server binding; do not fan out repeated calls across unrelated account IDs.

## Safe change workflow

1. Read current state: campaign, search terms, positive keywords, existing negative keywords, and recent `ads_list_changes` history.
2. Check `ads_get_capabilities` and the connected account policy before proposing a write.
3. Avoid duplicate work. Confirm current state and pending changes before creating anything.
4. Ground the change with current metrics plus relevant Ads memories/knowledge when available.
5. Call `ads_preview_change` or `ads_preview_changes`; show every diff, rationale, warning, scope, and approval requirement.
6. Wait for explicit operator approval of that exact preview, then call the approval tool.
7. Poll `ads_get_change_status` and verify by reading the affected resource again. Report partial failures and cancelled members separately.

## Search-term and negative-keyword review

- Classify intent at the query level. Style/year/photo/tutorial/reference modifiers are usually informational; location, booking, price and opening-hours modifiers are usually service-seeking.
- Inspect the matched positive keyword and match type.
- Read existing negatives before proposing additions. Check accent, singular/plural and phrase variants.
- Prefer phrase or exact negatives when a broad token can also describe a legitimate service.
- Do not broadly negate an ambiguous service verb without checking live positive keywords and offerings.
- Verify conditional segments against the live business and ads. Do not negate child-service or competitor queries automatically.
- Historical reports can show queries that are now excluded. Use current negatives, keyword status and change verification to determine present state.
