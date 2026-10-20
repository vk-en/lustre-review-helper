# Contributing to Lustre Review Helper

Plain CommonJS JavaScript, with no runtime npm dependencies and no build
step. `@vscode/vsce` is a development dependency used only for packaging.

```bash
npm ci          # development dependencies
npm test        # offline tests: real temporary Git repositories, fake agents
npm run build   # checks the package, then dist/lustre-review-helper-<version>.vsix
code --extensionDevelopmentPath="$PWD" /path/to/lustre-release
```

Without npm, `node scripts/test.js` and `node scripts/build.js` do the same;
the build needs `node_modules` from an earlier `npm ci`.

## Where things are

| Where | What |
| --- | --- |
| `src/extension.js` | The extension host: state, commands, the panel's messages |
| `src/service.js` | Review batches through `lreview`, shared with the MCP bridge |
| `src/view.js`, `media/review.js`, `media/review.css` | The panel |
| `media/scanner.js` | The scanning eye animation on Review |
| `src/mcp.js`, `src/bridge.js` | The MCP server and its link to VS Code |
| `src/gerrit*.js`, `src/publication*.js` | Gerrit: changes, lists, links, publishing |
| `src/l10n.js`, `l10n/*.json`, `package.nls*.json` | Translations |
| `src/migrate.js` | Storage of the extension's earlier identifier |
| `scripts/` | Tests, build and release |
| `.github/workflows/` | CI for pull requests, and releases from tags |

`src/service.js` invokes `lreview run --local` with argument arrays, pins refs
before launching, collects the `summary.json` and `gerrit-review-*.json`
artifacts and keeps per-run metadata. `src/mcp.js` implements the stdio MCP
tools; `src/bridge.js` connects it to the running extension.

## Tests

Tests use temporary real Git repositories and fake agent processes; they use no
model. The MCP integration test opens a local Unix socket, which needs socket
access if the test runner is sandboxed. Set
`LREVIEW_TEST_EXECUTABLE=/absolute/path/to/lreview` to also run the whole path
MCP → service → Python lreview → fake Codex, Claude or Auggie → artifacts,
with real worktrees.

A test that hangs fails after two minutes, and the run ends with the tests even
if one leaves a timer or a socket open.

`npm run build` checks that every script in `src/` and `media/` parses, and
that the package holds what the extension loads (its modules, the panel's
scripts, translations, the files `package.json` names) and nothing besides
`src/`, `media/`, `l10n/`, the manifests, README, CHANGELOG and LICENSE; then
it builds the `.vsix`.

A manual check in an Extension Development Host:

1. Open a trusted repository and check the newest 30 commits and the selection.
2. Select two non-adjacent commits and a model; run a light review with each
   installed agent. Switch agents and check that each keeps its model.
3. Check progress, results and links against the reviewed SHA.
4. Cancel another run and confirm its workers stop.
5. Connect an agent over MCP, start a review from it, and confirm it appears in
   the panel.

## Continuous integration

Every pull request and every push to `main` runs the tests on Ubuntu and macOS
with Node 20 (VS Code 1.96, the oldest the extension supports, runs it) and 22,
and builds the `.vsix`, which the run keeps for two weeks. The tests need no
network, credentials or installed tools.

## Translations

Text is English in the code, marked with `t('…')`, or
`tn(count, 'one …', 'other …')` for plurals, in `src/` and in
`media/review.js`; the panel's HTML is translated as a whole. Each
`l10n/<language>.json` maps the English text to the translation, a plural to
an object of its forms (`one`, `few`, `many`, `other`). `node test/l10n-keys.js`
lists every text, and the tests fail when a language misses one, has one
nothing uses, or changes a `{placeholder}`.

## Releasing

See [docs/RELEASING.md](docs/RELEASING.md).
