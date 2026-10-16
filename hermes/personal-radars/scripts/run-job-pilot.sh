#!/usr/bin/env bash
set -euo pipefail

prompt_file=/opt/personal-radars/prompts/job-prospecting.md
test -r "$prompt_file"
exec hermes --skills job-radar --oneshot "$(<"$prompt_file")"
