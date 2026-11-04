# Xmail Google runtime binding

Status: deploy wiring is prepared and the dedicated root-owned Google
environment file has been staged at its fixed host path. Its values are not
documented or printed here. Staging alone does not change the running
container; the read-only credential mount and environment take effect only on
the next deploy or container start. No deploy or container restart was
performed by this change. The current application container remains `xmail`.

## Fixed host contract

The deploy accepts only the root-managed files at these fixed paths:

| Purpose | Host path | Container path |
| --- | --- | --- |
| Google-only environment file | `/opt/xmail/google-identity-ops/google-auth.env` | Docker `--env-file` |
| X.509 runtime credential directory | `/opt/xmail/google-identity-runtime` | `/run/secrets/xmail-google-identity` (read-only bind) |

The environment file must be a regular, non-symlink, single-link `root:root`
file with mode `0600` and contain only unique `XMAIL_GOOGLE_AUTH_*` keys. It is
never sourced by the deploy script and its values are never printed. The workflow
does not pass its general GitHub environment or other secrets through this file.

If the environment file is absent, the deploy adds neither argument, preserving
the existing image default `XMAIL_GOOGLE_AUTH_ENABLED=false`. A present but
invalid file fails closed before `docker run`.

When the file is present, the host and certificate directory must also pass
validation: `/opt` and `/opt/xmail` are real root-owned directories without
group/other write permission; `google-identity-ops` is real `root:root` mode
`0700`; `google-identity-runtime` is real `root:root` mode `0750`. The runtime
directory must contain exactly `adc.json`, `certificate-config.json`,
`client.crt`, `client.key`, and `trust-chain.pem`. Each must be a regular,
non-symlink, single-link `root:root` file with mode `0600`, nonzero size, and a
per-file size bound. Partial certificates, unexpected entries, wrong ownership,
permissive modes, and symlink paths stop the container start with a generic
error; file contents and environment values are not included in diagnostics.

The checks run inside `run_app_container`, so they apply to the blue/green
candidate, the production container, and rollback starts. The bind is read-only
and uses only the fixed Xmail paths. Existing SMTP, IMAP, mail-server, and
Outlook token-encryption environment entries remain in the regular deploy list.

## Offline test

Run the isolated policy test with:

```sh
node --test scripts/ops/test-xmail-google-deploy.mjs
```

On Linux it executes the extracted workflow helper with temporary fixtures and
a metadata shim; it covers the absent-file default, accepted dedicated binding,
non-root ownership, permissive mode, missing certificate, generic environment
keys, symlinked key, and value redaction. It never invokes Docker or reads a
production file. The deployment workflow itself is not the test runner; the
identity CI workflow should invoke this command as a lightweight offline gate.

This wiring does not create or enable a Google provider, stage host files, change
the running container, or claim successful Google authentication. Those remain
separate operator and runtime proof gates.
