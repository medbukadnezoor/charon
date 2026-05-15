# Charon Production Deploy Runbook

Use this runbook for Charon code changes that affect the running VPS bot.

## Rule

Do not restart production Charon from loose, uncommitted files.

Emergency hotfixes are allowed only when the file list is explicitly bounded,
the previous remote files are backed up, and the hotfix is reconciled to Git
immediately after.

## Local Commit

1. Create a focused branch.

```bash
git switch -c codex/<short-fix-name>
```

2. Stage only the intended files.

```bash
git add <file-1> <file-2> <test-file>
git diff --cached --stat
git diff --cached
```

3. Run focused checks.

```bash
node --test <test-file>
npm run check
```

4. Commit and push.

```bash
git commit -m "<clear change summary>"
git push -u origin HEAD
```

## VPS Reconcile

1. Fetch the pushed branch on the VPS.

```bash
ssh moonbags 'cd /home/opc/charon && git fetch origin <branch-name>'
```

2. Check for dirty files that overlap the deployment.

```bash
ssh moonbags 'cd /home/opc/charon && git status --short -- <deploy-files>'
```

If a previous emergency hotfix left matching untracked files, compare them to
the pushed branch before removing or stashing them.

3. Switch the VPS to the pushed branch or exact commit.

```bash
ssh moonbags 'cd /home/opc/charon && git switch -c <branch-name> --track origin/<branch-name>'
```

If the VPS already has unrelated dirty files, do not use broad reset or
checkout commands. Stash or reconcile only the overlapping deploy files.

4. Verify the VPS checkout.

```bash
ssh moonbags 'cd /home/opc/charon && git rev-parse --abbrev-ref HEAD && git rev-parse HEAD'
ssh moonbags 'cd /home/opc/charon && npm run check'
```

## Position-Safe Restart

Always use the safe restart script so Charon does not restart while positions
are open.

```bash
ssh moonbags 'cd /home/opc/charon && node scripts/safe_restart_charon.js --charon-db=/opt/trading-data/charon.sqlite --dry-run --max-wait-minutes=0'
ssh moonbags 'cd /home/opc/charon && node scripts/safe_restart_charon.js --charon-db=/opt/trading-data/charon.sqlite --max-wait-minutes=1 --poll-interval-sec=5'
```

## Post-Restart Checks

```bash
ssh moonbags 'pm2 list --no-color | grep -E "charon|name|id"'
ssh moonbags 'pm2 logs charon --lines 80 --nostream --raw 2>/dev/null | tail -n 80'
```

For config-sensitive patches, also read the production SQLite database through
a read-only Node script and confirm the active strategy/settings values that
the code is expected to use.
