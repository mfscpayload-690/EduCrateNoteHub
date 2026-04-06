# GitHub Actions Setup

This repository uses three workflows:

1. `ci.yml`
- Runs on every pull request and push.
- Installs dependencies, validates syntax, validates JSON config files, runs security checks, and runs `npm audit`.

2. `netlify-preview.yml`
- Runs on PRs targeting `main`.
- Deploys a Netlify preview build and comments the preview URL on the PR.

3. `netlify-production.yml`
- Runs after CI succeeds on `main` (or manually via `workflow_dispatch`).
- Deploys production to Netlify and runs smoke checks.

## Required GitHub Secrets

Add these in **GitHub -> Repository -> Settings -> Secrets and variables -> Actions**:

- `NETLIFY_AUTH_TOKEN`
- `NETLIFY_SITE_ID`

## Netlify/Firebase Notes

- Ensure Netlify environment variables are configured for runtime (`OPENROUTER_*`, Firebase admin/client values, etc.).
- Ensure Firebase Auth authorized domains include your hosted domain (e.g. `edunoteshub.netlify.app`) for Google login.
