# GitHub Actions

Loreline ships an official example workflow you can drop straight into a
repository to gate merges on AI readiness.

## Copy the example

Copy [`examples/github-actions/loreline.yml`](../examples/github-actions/loreline.yml)
into your own repository at `.github/workflows/loreline.yml`. The workflow:

1. Checks out the repository and sets up Node.js 20.
2. Runs `loreline scan --fail-under 70`, which exits with status 2 (failing
   the job) when the readiness score is below 70.
3. Runs `loreline verify`, but treats it as advisory (`|| true`) until your
   repository has recorded interviews to verify.
4. Uploads the `.loreline/` directory as a build artifact, even on failure.
5. Writes a Markdown summary of the readiness score and finding statuses to
   the job's step summary.

The Loreline version invoked by the workflow (`@0.2.0`) is pinned for
reproducible CI runs. Bump the pin deliberately when you adopt a newer
release.

## Required permissions

The workflow requests only `permissions: contents: read`. It does not need
write access to your repository, issues, or pull requests.

## Downloading artifacts

After a run, open the workflow run in the GitHub Actions UI and download the
`loreline-report` artifact from the run summary page. It contains everything
Loreline wrote to `.loreline/`, including `readiness.json` and
`readiness.md`. GitHub CLI users can also fetch it with:

```bash
gh run download <run-id> --name loreline-report
```

## No external AI calls by default

The default workflow makes no external AI calls. `loreline scan` and
`loreline verify` are local, static analyses of your repository; nothing is
sent to a third-party AI provider unless you explicitly configure one.

## Enabling optional AI provider secrets later

Loreline's roadmap includes pluggable AI providers for adaptive interview
features. When that lands, you can opt in by adding a provider API key as a
repository secret (Settings > Secrets and variables > Actions) and passing
it to the workflow step, for example:

```yaml
- name: Assess AI readiness
  run: npx @tysoncung/loreline@0.2.0 scan --fail-under 70
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Until you add such a secret, no provider credentials are read or required.
