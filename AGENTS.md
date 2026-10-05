# Repository workflow

Use a topic branch for changes. Run the relevant checks, commit, push the branch,
open a pull request, and merge after all required checks pass and review
conversations are resolved. This is the default completion flow for authorized
repository changes; do not stop at a local preview or push directly to `main`.

Respect the active GitHub ruleset. Do not bypass protections, force push the
default branch, or weaken required checks to complete a task. Outside
contributions require maintainer review and merge access.

Follow `CONTRIBUTING.md` for package boundaries, validation, and private data.
Keep GitHub Actions permissions limited to the minimum required and pin Actions
to full commit SHAs from their official repositories.
