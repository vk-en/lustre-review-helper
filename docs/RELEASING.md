# Releasing Lustre Review Helper

For maintainers. Users install the extension from the Visual Studio
Marketplace or from a `.vsix` of a GitHub release.

## Once

1. Create a publisher at <https://marketplace.visualstudio.com/manage>. Its ID
   must match `"publisher"` in `package.json`; it becomes part of the extension
   ID (`<publisher>.lustre-review-helper`) and cannot change later.
2. Create an Azure DevOps personal access token with the **Marketplace →
   Manage** scope and **All accessible organizations**
   ([how](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token)).
3. In the GitHub repository, **Settings → Secrets and variables → Actions**,
   add it as the secret `VSCE_PAT`. Without it, releases go to GitHub only.
4. **Settings → Rules**: protect `main`, requiring the CI checks (**Tests …**
   and **Build the .vsix**) before a pull request merges. The release commit
   goes straight to `main`, so let yourself bypass the rule.

## The first release

Its version, `0.1.0`, and its notes are already in place. On a clean `main`
with everything committed:

```bash
npm run release -- 0.1.0 --dry-run   # checks, tests and builds; changes nothing
npm run release -- 0.1.0             # tests, builds and tags v0.1.0; no commit
git push origin main v0.1.0
```

Every later release starts with its notes under `## Unreleased`.

## Each release

1. Write the notes as you go, at the top of `CHANGELOG.md`, under
   `## Unreleased`.
2. On an up-to-date, clean `main`:

   ```bash
   npm run release -- patch --dry-run   # checks, tests and builds; changes nothing
   npm run release -- patch             # or minor, major, or an exact X.Y.Z
   ```

   It runs the tests, sets the version in `package.json` (also the title of
   the version button in the panel's title), `package-lock.json` and the
   README's badge, turns `## Unreleased` into `## X.Y.Z`, builds
   `dist/lustre-review-helper-X.Y.Z.vsix`, commits `Release X.Y.Z` (with
   Signed-off-by, signed if git is set up to sign) and tags `vX.Y.Z`. It
   pushes nothing. Without npm: `node scripts/release.js patch`.
3. Try the `.vsix` with **Extensions: Install from VSIX…**.
4. `git push origin main vX.Y.Z`. The **Release** workflow checks that the tag
   matches `package.json`, runs the tests, builds the `.vsix`, creates the
   GitHub release with it and the version's notes, and publishes to the
   Marketplace when `VSCE_PAT` is set.

To publish by hand instead: `npx vsce login <publisher>`, then
`npx vsce publish --packagePath dist/lustre-review-helper-X.Y.Z.vsix`.

The README's images are taken from the repository on GitHub, at
`https://github.com/vk-en/lustre-review-helper/raw/HEAD/docs/images/`, so the
Marketplace page shows them once `main` is pushed. The `docs/` folder itself
is not packaged.
