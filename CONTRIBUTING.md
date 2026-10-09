# Contributing

This repository is deprecated and retained as a legacy archive. It no longer
accepts contributions. Active product development belongs in
[xentropy-tech](https://github.com/shekkizh/xentropy-tech); access to that
repository is controlled separately. The guidance below is historical.

Fork this repository and open a pull request from a topic branch. Public access
does not grant permission to push or merge; repository write access is limited
to the maintainer. Do not push changes directly to `main`.

The default branch requires a pull request, passing package and consumer
validation on Node.js 22 and 24 on Linux and macOS, an up-to-date branch, and
resolved review conversations. Force pushes and deletion of the default branch
are blocked. The maintainer reviews and merges outside contributions. No second
approval is required while the repository has one maintainer.

Workflows for all outside contributors need maintainer approval before running.
CI has read-only repository permissions and does not require model credentials.
Keep third-party Actions pinned to full commit SHAs. New Actions require an
explicit update to the repository's Actions allowlist.

Use Node.js 22+ and run `npm ci`, `npm run check`, `npm test`, and
`npm run test:package` before opening a pull request. The tests do not require
model credentials. Add focused tests for changes to contracts, modes, bindings,
the portable workspace format, or installed-package behavior.

Keep the runtime independent of platform authentication, websites, hosting,
persistence, billing, and demo applications. Application adapters belong in
their own projects. Generated `dist/` files are not committed; `prepare` and
`prepack` build from source. Pin changes to the official Codex dependencies
deliberately, and preserve the restricted simulation policy.

Do not commit credentials, local Codex settings, personal execution traces,
customer context, or model outputs containing private data. Contributions are
provided under the project's Apache-2.0 license.
