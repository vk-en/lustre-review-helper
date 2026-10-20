# Changelog

## 0.1.0

The first release: AI review of Lustre patches in the VS Code sidebar, through
[`lreview`](https://github.com/lustre-tools/llm_code_and_review_tools).

- **Review local commits and Gerrit changes together.** Tick commits of your
  branch and Gerrit patchsets, and they are reviewed in parallel, each in its
  own Git worktree pinned to its exact SHA. Your checkout and uncommitted edits
  are never touched.
- **The Lustre protocol**: the `review-core` deep dive of
  [review-prompts](https://github.com/verygreen/review-prompts), or a cheap
  single-pass **Light** review.
- **Your agent, your model**: Codex, Claude Code or Augment (Auggie CLI), with
  the models and reasoning levels the installed client reports.
- **Live progress**: each review's state, elapsed time, tokens, cost and, for
  Codex and Claude Code, the account limits left. **Cancel** keeps what is
  done.
- **Reports & History**: every review per repository, in Local and Gerrit
  tabs, with search, quick filters, hover cards and the general information of
  a review: its change on Gerrit with CI and votes, findings by kind and the
  files with findings.
- **Findings in the diff**: the reviewed commit in VS Code's multi-file diff,
  every finding a comment thread under its line, next to the unresolved Gerrit
  discussions of the patchset; the Comments panel jumps to any of them.
- **Local commits** show their state on Gerrit: the same commit, another
  version of it, merged, or a merge conflict.
- **Gerrit patches**: add a change by URL, or pick from **Waiting Review** and
  **In progress**, with CI, votes, owner replies and other people's AI reviews,
  as a list, cards or groups.
- **Checks before you publish**: someone else's AI review of the patchset, a
  newer patchset (and whether it touches files with findings), a merge
  conflict, and one AI review per patchset across all your VS Code windows.
- **Publish to Gerrit** on purpose: unlock, then publish the assessment and the
  inline comments to exactly the reviewed patchset, signed with your bot name,
  without a vote.
- **Self-review over MCP**: Codex, Claude Code or Auggie CLI can start a
  review of their own commit, read the findings, fix them and review only what
  changed.
- **AI Settings**: sign-in for each agent, the agent and model, the installed
  tools and the Gerrit connection, MCP connections, and housekeeping.
- **Six languages**: English, Deutsch, Español, 日本語, 简体中文 and Русский,
  following VS Code by default.
- The version in the panel's title opens this changelog.
