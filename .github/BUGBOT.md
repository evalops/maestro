# Cursor Bugbot Autofix

## Race condition with concurrent pushes

Cursor Bugbot Autofix pushes commits directly to PR branches. When a human
or agent is also pushing to the same branch, this causes rebase conflicts
and rejected pushes.

### Recommended workflow

1. **Always `git pull --rebase` before pushing** to integrate any autofix
   commits that landed while you were working.
2. **If a push is rejected**, fetch and check for autofix commits:
   ```bash
   git fetch origin <branch>
   git log --oneline HEAD..origin/<branch>
   ```
3. **If an autofix commit addresses the same issue you just fixed**, skip
   your commit (`git rebase --skip`) and keep the autofix, or resolve the
   conflict in favor of whichever fix is more complete.
4. **Do not force-push** to overwrite autofix commits — rebase instead.

### Configuration

Bugbot autofix behavior is configured at
[cursor.com/dashboard/bugbot](https://www.cursor.com/dashboard/bugbot),
not in this repo. To disable auto-push entirely and keep comment-only
reviews, uncheck "Autofix" in the dashboard.

### When autofix is helpful

Autofix is most valuable for generated mirror PRs (`sync/public-release-mirror`)
where no human is actively pushing. For feature branches under active
development, consider disabling autofix to avoid the race.
