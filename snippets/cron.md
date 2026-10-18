# Snippet: plain cron scripts

`run` wraps any command: exit code 0 is recorded as `ok`, anything else as `fail`, together with the duration and the last
line of output. It exits with the command's own exit code, so cron and your other tooling still see failures.

```cron
# m  h  dom mon dow  command
  5  *  *   *   *    cd /srv/ops && npx --yes agent-control-tower@0 run --task db-backup --every 1 --push -- ./backup.sh >> /var/log/backup.log 2>&1
```

- `--every 1` is only needed the first time (it registers the task with a 1 h schedule).
- `--summary "Backup uploaded"` replaces the automatic `exit 0 in 41s` on success. Failures always show the exit code and
  the last output line, unless that line looks like a secret, in which case it's hidden.
- The machine needs push access to the repo (an SSH deploy key with write access is the usual choice for servers).
  Without `--push` the record is only written locally; commit it some other way.
- Want the cron job to call an LLM agent? Wrap it the same way: `run --task nightly-research -- claude -p "$(cat prompt.md)"`.
  Only the exit code is checked, so the [Claude Code snippet](claude-code.md) gives you better summaries.

## systemd timers

```ini
# /etc/systemd/system/db-backup.service
[Service]
Type=oneshot
WorkingDirectory=/srv/ops
ExecStart=/usr/bin/npx --yes agent-control-tower@0 run --task db-backup --push -- ./backup.sh
```

## GitHub Actions

Add a last step that always runs:

```yaml
permissions:
  contents: write   # to push the record

steps:
  # ... your job ...
  - name: Record run in the control tower
    if: always()
    run: |
      status=ok
      [ "${{ job.status }}" = "success" ] || status=fail
      git config user.name "github-actions[bot]"
      git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
      npx --yes agent-control-tower@0 log --task pr-triage --status "$status" \
        --summary "job ${{ job.status }} (run #${{ github.run_number }})" \
        --link "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" --push
```

Pushes made with `GITHUB_TOKEN` don't start other workflows, so the Pages workflow template also rebuilds on a schedule.
