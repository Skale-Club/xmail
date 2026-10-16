#!/usr/bin/env bash
set -euo pipefail

prompt_file=/opt/personal-radars/prompts/apartment-prospecting.md
test -r "$prompt_file"
exec hermes --skills apartment-radar --oneshot "$(<"$prompt_file")"
