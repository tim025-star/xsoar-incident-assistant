# Security policy

## Supported versions

Security fixes are applied to the latest revision on the default branch.

## Reporting a vulnerability

Do not open a public issue containing credentials, browser-session data, tenant names, incident content, or reproduction material that exposes customer information. Contact the repository owner privately through GitHub and include only synthetic reproduction data where possible.

## Data-handling expectations

- Never commit `config.json`, browser profiles, logs, generated templates, screenshots, captured production HTML, or incident exports.
- Test data must use fictional organizations, reserved domains, and documentation IP ranges.
- Keep Chromium remote debugging bound to loopback and use a dedicated browser profile.
- Configure `allowedXsoarOrigins` with exact trusted HTTPS origins.
- Treat generated drafts as sensitive and review them before external use.

## Release checks

Before publishing a release, scan the current tree and all reachable Git history for secrets, employee identifiers, customer names, tenant codes, private paths, internal domains, and production-derived fixtures. A clean current branch does not make earlier commits safe to publish.
