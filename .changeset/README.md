# Changesets

Version management for the workspace packages. See
https://github.com/changesets/changesets for details.

- `pnpm changeset` — record a change against the packages it touches.
- `pnpm changeset version` — apply pending changesets and bump versions.

All packages are currently private; `privatePackages.version` is enabled so
they still get versioned (no npm publish, no git tags).
