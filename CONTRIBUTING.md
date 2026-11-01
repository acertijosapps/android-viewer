# Contributing

Contributions are welcome. Keep changes small, focused, and traceable.

## Development workflow

Use the Node.js version in [`.nvmrc`](./.nvmrc). Install dependencies from the root:

```sh
npm install
```

`npm install` also wires the repository git hooks (`core.hooksPath` → `.githooks/`).

You need the Android SDK (`adb` and `emulator`). The tools are looked up in `ANDROID_HOME`, `ANDROID_SDK_ROOT` or the default SDK location; override them with `ADB` and `EMULATOR`.

### Commands

```sh
npm start        # start the viewer on http://localhost:8093
npm run mcp      # start the MCP server (stdio)
npm run check    # syntax-check the sources
```

## Branching model

Two permanent branches, both protected:

- **`main`** — production. No direct pushes; changes land only through an approved Pull Request.
- **`beta`** — release candidate.

Temporary branches, always created from `beta`, in kebab-case:

- `feat/<name>` · `fix/<name>` · `chore/<name>` → Pull Request **into `beta`**, deleted after merge.
- `hotfix/<name>` is the only exception: created from `main`, PR into `main`, then back-merged into `beta`.

One branch = one focused change.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<optional scope>)(!): <imperative description>
```

Types: `feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert`.

[SemVer](https://semver.org/) mapping: `feat` → MINOR, `fix` → PATCH, breaking (`feat!` or `BREAKING CHANGE:`) → MAJOR.

The git hooks in [`.githooks/`](./.githooks) run for every commit:

- `commit-msg` rejects messages that are not Conventional Commits.
- `pre-commit` blocks direct commits on `main` and `beta`.

One-off bypass (not recommended): `git commit --no-verify`.

## Changelog

Any change that affects behavior updates [`CHANGELOG.md`](./CHANGELOG.md) ([Keep a Changelog](https://keepachangelog.com/)): add the entry under `## [Sin liberar]` in the right category (Añadido · Cambiado · Corregido · Eliminado).

## Pull Requests

When opening a PR:

- Target `beta` (or `main` only for `hotfix`).
- Keep it small and focused on one change.
- Assign at least one reviewer; merge requires their approval.
- Link the related work item for traceability.
- Gates must be green: `npm run check`. CI ([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)) runs it on every PR to `beta` or `main`.
- Include the `CHANGELOG.md` entry.

## Releasing (`beta` → `main`)

1. Confirm gates are green on `beta`.
2. Decide the SemVer bump from the commits since the last tag.
3. Update `version` in `package.json`.
4. Rename the `## [Sin liberar]` section of the changelog to `## [X.Y.Z] - YYYY-MM-DD` and open a fresh empty one.
5. Tag `vX.Y.Z` on `main`.
