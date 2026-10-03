# Releases

Two channels are branches on GitHub. The dashboard (Settings → Updates) and `git` read them.

| Branch | Moves when |
|---|---|
| `latest` | Every release. |
| `stable` | A release that has been checked on `latest`. |

Both branches only move forward. Never force-push them: the dashboard refuses to update a copy whose branch cannot fast-forward.

## Cut a release

1. Merge the changes into `main` and set `"version"` in `package.json` (for example `0.3.0`).
2. Tag `main` and move `latest` to it:

   ```bash
   git switch main && git pull --ff-only
   git tag -a v0.3.0 -m "v0.3.0"
   git push origin v0.3.0
   git push origin main:latest
   ```

3. Publish the GitHub release with notes written for users:

   ```bash
   gh release create v0.3.0 --title "v0.3.0" --notes-file notes.md
   ```

## Promote to stable

Once the release has run on `latest` without trouble:

```bash
git push origin v0.3.0^{commit}:refs/heads/stable
```

A copy on `stable` sees the update the next time someone presses Check for updates.
