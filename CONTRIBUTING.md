# Contributing

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
