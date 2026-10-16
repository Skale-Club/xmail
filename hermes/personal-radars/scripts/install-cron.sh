#!/usr/bin/env bash
set -euo pipefail

apartment_name=personal-apartment-radar
job_name=personal-job-radar
apartment_comparison_name=personal-apartment-comparison
job_comparison_name=personal-job-comparison

job_id_for() {
  node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync("/opt/data/cron/jobs.json", "utf8")); const job=data.jobs.find((item) => item.name === process.argv[1]); process.stdout.write(job?.id ?? "")' "$1"
}

upsert_job() {
  local name=$1
  local schedule=$2
  local deliver=$3
  local skill=$4
  local prompt_file=$5
  local job_id
  job_id=$(job_id_for "$name")

  if [[ -n "$job_id" ]]; then
    hermes cron edit "$job_id" \
      --name "$name" \
      --schedule "$schedule" \
      --deliver "$deliver" \
      --skill "$skill" \
      --workdir /opt/personal-radars \
      --prompt "$(<"$prompt_file")"
  else
    hermes cron create \
      --name "$name" \
      --deliver "$deliver" \
      --skill "$skill" \
      --workdir /opt/personal-radars \
      "$schedule" \
      "$(<"$prompt_file")"
  fi
}

upsert_job "$apartment_name" '0 8 * * *' telegram:-5472550104 apartment-radar /opt/personal-radars/prompts/apartment-prospecting.md
upsert_job "$job_name" '15 8 * * 1-5' telegram:-5422244642 job-radar /opt/personal-radars/prompts/job-prospecting.md
upsert_job "$apartment_comparison_name" '0 18 * * 0' telegram:-5472550104 apartment-radar /opt/personal-radars/prompts/apartment-comparison.md
upsert_job "$job_comparison_name" '15 18 * * 0' telegram:-5422244642 job-radar /opt/personal-radars/prompts/job-comparison.md
