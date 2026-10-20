# Lustre Review Helper: full reference

Everything the extension does, in detail. For an overview with pictures, see the
[README](../README.md).

Review selected local commits with the **lreview Lustre protocol** of
[LLM Code and Review Tools](https://github.com/lustre-tools/llm_code_and_review_tools). The extension adds an Activity Bar icon, a commit picker,
an **AI Settings** section, Codex/Claude Code/Augment model selection,
live usage statistics, review results, and an MCP interface that Codex can
use for self-review.

## Install

1. Install the tools and review prompts from
   [LLM Code and Review Tools](https://github.com/lustre-tools/llm_code_and_review_tools):

   ```bash
   git clone https://github.com/lustre-tools/llm_code_and_review_tools.git
   cd llm_code_and_review_tools
   ./install.sh --venv
   ```

   Python 3.11+ and Git are required. For this extension, local reviews do
   not require Gerrit credentials. Existing review prompts can still consult
   public Gerrit discussions when network access is available.

2. Install/sign in to the Codex or Claude Code VS Code extension, or use an
   already authenticated CLI. Lustre Review Helper first looks for the selected
   agent's binary shipped with `openai.chatgpt` or `Anthropic.claude-code`,
   then on PATH. Only the agent you select needs to be installed.
   For **Augment**, install the official [Auggie CLI](https://docs.augmentcode.com/cli/setup-auggie/install-auggie-cli)
   (`npm install -g @augmentcode/auggie`, Node.js 20+) and run `auggie login`.
   An Augment IDE login alone does not configure this CLI integration.

3. Install **Lustre Review Helper** from the Visual Studio Marketplace: search
   for it in the Extensions view. To build it from source instead (Node.js 20+
   and npm), run in this repository:

   ```bash
   npm ci
   npm test
   npm run package
   ```

   and choose **Extensions: Install from VSIX…** with the resulting `.vsix`.

4. Open the Lustre Git repository, trust the workspace, and click the
   **Lustre Review Helper** icon in the Activity Bar.

If `lreview` is not on VS Code's PATH, set **Lustre Review: Lreview Path** to
the absolute executable path, for example
`/path/to/llm_code_and_review_tools/.venv/bin/lreview`. Paths are executable
paths, not shell commands. There are separate **Codex Path**, **Claude Path**
and **Auggie Path** overrides.

Linux and macOS are supported. On Windows use a **Remote WSL** or **Remote
SSH** workspace and install the extension, lreview, and selected agent on the remote
host. The existing lreview backend depends on POSIX process groups and
`fcntl`. A remote workspace needs a remote agent installation/login.

## Use

- **Sections:** AI Settings, Local commits, Gerrit patches, Review and Reports & History form an accordion: opening
  one collapses the others. Headers stay visible while the open section
  scrolls. Commits opens initially; the last open section is remembered.
  Collapsing the active section returns to **Review**, so one section stays open.
  Use the gear in the panel title to open AI Settings directly. Left of it,
  the extension's version (`vX.Y.Z`) opens the changelog.
- **AI Settings:** the first panel, collapsed by default. Choose
  **Codex / Claude Code / Augment**, a model, an
  optional reasoning effort, and Full or Light review depth. This separate
  section shows the selected agent/model/effort on the right of its header,
  in one line even when collapsed. Hover truncated text to read it in full.
  Its contents sit in six folder tabs drawn like Reports & History, each with
  a tooltip: **Accounts** (agent sign-in), **Agent** (agent, model, reasoning
  and depth), **Utilities** (git, lreview, gerrit-cli with the bot name and
  Gerrit connection, gerrit-dashboard), **MCP** (self-review connections),
  **Other** (commits to display, Reset statistics, Clear history) and, as a
  translate icon only, **Language**. Refresh connections sits at the
  bottom of the Accounts tab; its tooltip opens upward so the pane edge never
  cuts it. Under the MCP tab an **Examples** block lists plain-language requests for a
  connected agent: review the last commit, fix the findings of the branch's
  patch and review again, read the review selected in VS Code, or find a
  review by subject or hash. A yellow dot marks a tab that needs attention, with the reason
  in its tooltip: a missing or outdated utility, no signed-in agent, no
  model. When the panel is narrow the tabs read Acc and Util, then tighten,
  then show icons. The chosen tab is remembered; a review that cannot start
  opens the tab that holds the fix (Utilities for a missing lreview,
  Accounts for an agent that is not signed in).
  **Utilities** lists **git**, **lreview**, **gerrit-cli** and **gerrit-dashboard**; **Accounts** has
  connection cards for all three agents. **?** opens the official setup guide; its immediate
  tooltip displays the destination URL. The **lreview** card shows installation
  status, executable path, and version when `lreview --version` provides it.
  Its **?** always links to GitHub, including when lreview is installed.
  The **git** card shows the version and PATH location of `git`, the one every
  Git call of the extension and lreview runs. Git 2.24 or newer is required
  (the extension relies on `git rev-parse --end-of-options`); an older or
  missing Git is shown in red with **Download Git ↗**, and **?** opens
  https://git-scm.com/downloads. Review diffs need nothing else: no
  extra tools, network or Gerrit access, only VS Code's built-in diff and
  comments.
  The **gerrit-dashboard** card shows whether the tool is installed and where.
  It is optional: only Waiting Review and In progress under Gerrit patches use
  it. The extension looks for it beside lreview and gerrit-cli, then on PATH and
  in `~/.local/bin`, or uses `lustreReview.gerritDashboardPath`.
  The **gerrit-cli** card shows installation status, version and executable path.
  Gerrit CLI is needed to read private changes and publish reviews on Gerrit.
  **Check connection** runs the read-only `gerrit check` command; it also runs
  once at startup and on Refresh connections, without blocking the panel.
  Connected confirms authentication only, not permission to publish to a project.
  Older CLIs without `check` show an update hint. **Bot name** saves a signature
  for reports and Gerrit publishing: `[Bot name]`, or `[AI review]` if empty.
  **Include model and reasoning in signature** is off by default and saves
  immediately. Enable it for `[Bot name - model - reasoning]`, using Default
  when no reasoning level is selected. The preview shows the selected model.
  These settings apply to new reviews and do not change the Gerrit account.
  New reports include this signature under Overall assessment.
  **Open Gerrit CLI configuration** opens the CLI's own file, honoring
  `GERRIT_CLI_ENV_FILE` and its standard file precedence. If absent, an explicit
  click creates a mode-0600 template with empty credentials. Environment variables
  still take precedence. The extension stores no Gerrit username or password.
  A **Gerrit Path** override is available; otherwise discovery tries the lreview
  installation directory, PATH and standard binary locations. Gerrit is optional
  for local reviews.
  If it is missing, Review is disabled and
  **Download lreview** opens [the GitHub repository](https://github.com/lustre-tools/llm_code_and_review_tools).
  Installation is rechecked when returning to VS Code, refreshing connections,
  changing the executable path, or starting a review. **Sign in** runs
  the agent's official login flow in a terminal; **Sign out** uses its logout
  command. Connected accounts have a green check; signed-out accounts have a
  red cross. Sign in is disabled when the CLI is missing. Model controls stay
  hidden until at least one agent is connected. Self-review connections are below.
  Each installed client shows its CLI version when available. **Refresh connections** checks versions, account status and
  lreview and saved self-review MCP settings again; its question-mark tooltip explains the action.
  Set **Commits to display** and click **Apply** to refresh the list (1–200,
  default 30). This saves a user preference unless the workspace already
  overrides the limit.
  Model and commit-list settings are separated visually.
- **Local commits:** the newest commits reachable from HEAD, with checkboxes,
  each with its author date as day.month before the subject. The open
  repository's path sits above the buttons after a folder icon; hovering says
  it is the current project, and clicking chooses another. Refresh, Select all, Clear and Show/Hide merged carry blue
  icons. While every label fits on one line they form one segmented strip;
  otherwise they become outlined buttons, two by two, then one column. The
  layout follows the measured labels, not a fixed width. Hover washes a
  button in the theme's focus colour and pressing deepens it; Show merged
  stays lit while merged commits are hidden. Each has a tooltip, shown below
  the buttons across their row. The current Git branch appears on the right of the recent-commit count,
  after a branch icon; hovering it says it is the current branch.
  Detached checkouts show Detached HEAD and the short commit SHA instead.
  **Show merged / Hide merged**, after Clear, toggles commits that already
  landed; they are hidden by default, so the button first reads Show merged,
  and its tooltip, shown below it, names the branch compared with. Landed means already on the
  remote branch this work is based on: the branch's upstream, or else the
  remote-tracking branch with the fewest commits of HEAD missing from it
  (Gerrit topic branches often have no upstream). A commit also counts as
  landed when that branch has a commit with its Change-Id, since Gerrit may
  cherry-pick or rebase on submit. The comparison uses what the last fetch
  brought. Shown merged commits are dimmed, the count says how many are
  hidden, and hiding them deselects them. Without any remote branch the
  button is disabled. The most recent visible commit is initially selected. The repository button
  switches between open Git repositories. Clicking a commit opens its diff in VS Code's multi-file diff
  editor, as Reports & History opens a review: the commit message first, then
  every changed file against the parent, read from Git without a checkout.
  After the date a link icon shows the commit's change on Gerrit, found by its
  Change-Id (the base branch first): green when the change's current patchset
  is this very commit, orange when it differs (amended locally, or Gerrit has
  another version), blue once merged, grey when there is no Change-Id or no
  such change. When the commit is the change's current patchset but Gerrit
  cannot merge it (Merge Conflict), one link of the chain turns red, and the
  hover details add a Merge conflict chip with a hint to rebase onto the
  latest branch and upload a new patchset. That needs gerrit-cli 0.2.45 or
  newer, whose `gerrit info` reports `mergeable`; an older one shows no
  conflict. Clicking the icon opens the change. Lookups use `gerrit info`, run in
  the background, are shared by all windows and checked again every five
  minutes; merged changes are final. Hovering a commit shows its details in
  color: subject, short hash, whether it is merged, its Gerrit state, author,
  date and full hash.
  Selection survives refreshes and clears when a review finishes. Its header shows the selected commit count,
  including when Commits is collapsed.
- **Gerrit patches:** three folder tabs. **Gerrit URL** adds a change by its
  URL, as described below. **Waiting Review** lists the open changes of the
  repository's Gerrit project where your Gerrit account is a reviewer and has
  not yet voted, commented or published a review. **In progress** lists those
  you already reviewed or commented on: a new patchset since your review
  (`PS 6 → 11`, blue edge), an owner reply after your last message (yellow
  edge), still waiting for the author (grey edge), and your own +1 (green
  edge). WIP changes and your own changes are left out.
  One **Refresh** reads both lists with `gerrit-dashboard refresh --projects
  <project>` in the extension's own data directory, then reads
  `gerrit comments --all --no-context --timeline` only for changes updated
  since the last refresh, to find owner replies and other people's AI reviews. A refresh takes about
  ten seconds; the first look at a project loads it. After that the lists
  refresh by themselves every five minutes, in one window of the project
  only: whichever window's timer comes first refreshes, the others skip while
  it runs and pick up its result. **Refresh** still refreshes at once. **Updated N min ago** shows its age. The last refresh of each project
  is saved and shared by every window of that project, also across restarts.
  Each list has a filter: a checkbox means show, and a change is hidden when it
  matches any unticked entry. Waiting Review filters on failed and still
  running build or tests, a +1 or a −1 from another reviewer, and ready for
  landing; In progress on no updates since your review, your +1, failed and
  running build or tests, ready for landing and a −1 from another reviewer.
  By default unfinished CI is hidden in both, and your +1 in In progress.
  **Reset** restores these defaults; **Show all** under the list clears the
  filter. Ready for landing means build and tests passed, no negative vote and
  two positive votes from people other than the owner (yours counts). The tab
  counters show the changes listed in Waiting Review and the changes updated
  since your review in In progress. Code-Review votes on the current patchset
  show as slots, at least two since landing needs two +1: grey while empty,
  green for a positive vote, red for a negative one, yours included; plus
  signs in List and Cards, dots one above the other in Groups, next to the
  build and tests mark.
  Tick a change to add its current patchset to the next review, as if its URL
  was added. A change whose current patchset already has a published AI review
  cannot be ticked. A purple icon marks a finished AI review of the current
  patchset that is not published yet, from any window of the project: in this
  window it opens the report in Reports & History, otherwise it names the
  folder of the window that holds it. Publishing moves a change to In progress
  at once. A cyan robot marks a change whose current patchset already has
  an AI review by someone else (comments signed like `[AI review - opus]` or a
  bot name, or by the Lustre AI review bot); hover it for who, when, the
  signature and the number of comments. The external-link icon opens the change in Gerrit. Hover a change
  for its details in color: patchsets, owner reply, build and tests with
  failed test names, every vote, AI review state, branch and unresolved
  comments. The eye icon beside the filter chooses the view for both lists,
  each menu item with a small picture of it:
  **List** (two lines per change), **Cards** (all details at a glance) or
  **Groups** (one line per change, In progress grouped by kind and Waiting
  Review by CI state, groups collapse). The choice is kept for all windows.
  When something keeps Gerrit from working, the tabs say what and offer the
  fix as buttons: Choose repository, Open Utilities, Install guide, Gerrit CLI
  configuration (opens gerrit-cli's `.env`), Check connection (opens
  Utilities and checks the login) or Retry. A failed connection check is
  shown before any refresh is tried.
  On the Gerrit URL tab, paste a change URL from `https://review.whamcloud.com` and
  click **Add commit**. The extension validates the exact HTTPS origin and calls
  `gerrit info` against that server before adding the patch. Public changes can
  be read without signing in; private changes require access through Gerrit CLI.
  The returned project must match the current Git repository's Gerrit project:
  `ex/lustre-release` and `fs/lustre-release` are distinct. Identity comes from
  `origin`, then the current branch's tracking remote, then a single unique
  Gerrit project in other remotes. HTTPS, SSH/SCP and Git transport URLs on
  `review.whamcloud.com` are supported, including Git `insteadOf` aliases.
  Conflicting fetch/push projects or an unknown mapping produce an actionable
  error instead of accepting a patch. Remote credentials never enter the UI.
  The project is checked again before starting a review. Switching repositories
  clears the preparation list and cancels pending lookups.
  Short, project and legacy hash URLs are accepted. Explicit patchset numbers
  are checked; otherwise the current patchset is recorded at the time of adding.
  Each entry shows the full subject (including its ticket), the change owner
  returned by Gerrit CLI, and its change/patchset number. Use **×** to remove it.
  The header shows the count even when collapsed. The preparation list clears
  on window reload and when a review finishes (including cancellation or failure).
  Duplicate changes are rejected. All entries
  in this list are selected for the next review; remove an entry to exclude it.
- **Review:** shows **N local commit(s) selected** with titles and short SHAs,
  followed by **N Gerrit patch(es) selected** with titles and patchset numbers.
  **Start review** reviews both lists. It also works with only Gerrit patches
  selected, using the local repository chosen in Local commits as the Git
  object store. Local commits run first, then Gerrit patches, with a shared
  progress counter, usage totals and Cancel action. Each item gets its own
  report and history entry. Reviewing does not publish results; publication is a
  separate action in Reports & History. Both preparation lists clear after the batch finishes.
  While a review runs, commit checkboxes, Select all, Clear, the repository
  picker, Add commit and patch removal are disabled: a running batch cannot
  take more targets, and its end would otherwise drop them.
  Gerrit inputs use lreview's native Gerrit mode with explicit patchset URLs.
  lreview fetches missing commits and creates detached worktrees on their exact
  revisions, without switching the main checkout or modifying uncommitted edits.
  Prefer a local clone of the Gerrit project to reuse its objects and remotes.
  Private patches need both API access through Gerrit CLI and Git fetch access
  through an existing SSH remote/key or HTTPS credential helper. Authenticating
  Gerrit CLI alone does not configure Git credentials.
  The status card shows the agent, model and reasoning above **Ready for review**,
  for example **Claude Code · Opus · max**, beside the animated robot. While a
  review runs, this identifies that run's settings, including MCP overrides.
  The button is labeled **Start review**.
  A square log icon, Start review and (during reviews) Cancel share a row
  below the statistics card, in that order.
  **Open reports in new tabs when finished**, between the card and buttons,
  is enabled by default and saved for the workspace. Disable it to keep
  completed reports in Reports & History until opened manually. It also applies to MCP runs.
  A disabled Review button explains why in its immediate tooltip; the enabled
  tooltip explains the Lustre protocol and exclusion of uncommitted edits.
  Each selected commit or patchset is reviewed separately in
  a worktree pinned to its SHA. Uncommitted changes are excluded.
- **Batch progress:** while a batch runs, the selected commits and patches
  become a progress list, one line each: a spinning ring and its own time,
  counting up in blue, while it is reviewed; an empty ring and *queued*
  while it waits; once done, a dot and its findings by type (a red dot with
  the count of defects, an orange one for minor, and so on, as in the report
  card), a green check for no findings or a red cross for a failed review,
  and its own time. The tooltip adds the cost. Click a finished line to open
  its report in Reports & History, or a failed one to open the log. The
  extension reads progress from lreview's log as it arrives, since lreview
  writes its summary only when the whole batch ends; until a review's report
  is read, its findings show as one count colored by the severity lreview
  logged. Reviews run in parallel (Lustre Review: Jobs), so one long review
  may take almost as long as the batch.
- **Live statistics:** under the list, the animated blue robot (it winks and
  looks around) sits beside the agent, model and reasoning, with a gear that
  opens AI Settings → Agent, and the status:
  plain **Ready for review** before a review, then a colored pill, blue
  *Review in progress* with the age of the last agent activity, amber while
  waiting for the agent or for a status update, green *Review completed*, red
  when failed. One line of numbers follows and refreshes every second:
  elapsed time, tokens (6.0M; the exact count, and whether usage is partial,
  in the tooltip), cost (whether it is an API estimate in the tooltip) and
  how many reviews are done.
- **Scanner animation:** only while a review runs, a dot drawing above the
  robot: an eye looks down at files of machine code that ride a belt, each a
  page of bits with a folded corner. A fan of light opens from the pupil and a
  laser line walks down the file; the lines it passes light up, now and then a
  byte turns amber or red like a finding, the file gets a check and the belt
  brings the next one. The pupil follows the laser, the eye blinks now and
  then, rays flicker at its sides and a faint green rain falls far behind. It
  is a loop with no start or end, green in both themes: dark on dark themes,
  light on light ones. It pauses while hidden and shows one still frame with
  reduced motion. Animation is not proof of agent progress; the last-activity
  age comes from actual worker output.
- **Clearing Review:** a finished batch stays on Review until you go to
  another section; then Review returns to the selection and **Ready for
  review**, and the reports stay NEW in Reports & History. A batch that
  finished while you were elsewhere is shown when you come back and cleared
  when you leave again. Changing the selected commits, agent, model,
  reasoning or review depth clears it too, as does reading all its reports.
  Selecting history never changes the Review card, and a running review
  keeps its live counters until it finishes.
- **All-time usage:** collapsed by default; use **Show / Hide** on the right of
  the footer heading to expand or collapse the table without resetting any data.
  The footer stays at the bottom of Review, directly above Reports & History. Review
  content scrolls above it; a long expanded table has its own scroll area.
  The compact Review footer groups usage across all projects by
  **Agent / Model / Cost / Tokens**, including MCP runs, cleared history and
  reported consumption from cancelled or failed reviews. Existing saved reviews
  are imported from other VS Code workspaces on upgrade and when a window opens.
  Windows sharing the extension's global storage synchronize totals every five
  seconds. Early Codex-only records without an agent field are labeled Codex.
  Live snapshots replace previous measurements, so
  refreshes and per-patch history entries do not double count a batch.
  Tokens use **k** for thousands and **M** for millions; hover to see the exact
  count. Costs have two decimal places, with estimates marked `*` and partial
  totals marked `≥`; unavailable data stays `—`. Augment credits remain separate
  from USD. Totals are saved independently of history and report files.
  **AI Settings → Reset statistics** clears only these shared totals and
  starts counting new reviews, preserving history and reports. A divider and
  a short description separate this action from MCP settings. It is unavailable
  while a review is running in the current window. Reviews started before the
  reset stay excluded, including snapshots arriving later from another window.
  Clear history never resets usage totals. Separate VS Code profiles or remote
  extension hosts with different global storage keep separate totals.
- **Open log:** the square terminal icon to the left of Start review opens
  the separate **Output → Lustre Review Helper** panel and streams
  that run's output there. Logs are not embedded in the Review view.
- **Reports & History:** **Local** and **Gerrit** tabs, each with its review
  count and NEW count, are drawn as folder tabs: the chosen one and the panel
  under it share one colour and meet in one smooth curve, like a folder holding
  its contents, and the other tab is a rounded blue tab beside it. Tabs are as
  wide as their labels. When a narrow panel cannot fit them, NEW turns into a
  green dot, then the labels shorten to L and G with plain counts; the tabs'
  accessible names keep the full text. Each tab chooses its review from its own
  list. The closed list shows the chosen review on one line; it opens below
  it, or above when there is more room, and keeps to the window:
  - **One line per review or group.** Gerrit reviews are grouped by change,
    local ones by commit with all its versions (by Change-Id). A group's own
    line has the change number (Gerrit), the subject with its ticket, whether
    the newest review is published, the number of reviews (×5) and the date;
    it shows no result, since its reviews may differ. A review's line has a
    dot in the color of its most severe finding (green: no findings), the
    change number and **PS** on Gerrit, or the link to Gerrit on Local (green:
    Gerrit has this very commit, orange: another version, gray: not on
    Gerrit), the subject, a cloud for publication (green: published, gray: not)
    and the time today or the date before. A blue dot after the date marks an
    unread review. Inside a group, each review shows its patchset or its short
    hash, the model and reasoning, publication and date. On Gerrit, **PS 9 → 10**
    in orange means Gerrit has a newer patchset than the reviewed one. On
    Local, the cloud shows only for a commit Gerrit has as is: whether an AI
    review of that patchset is published.
  - **Search and quick filters.** Search by change number or URL, ticket,
    subject, hash or model. **All**, **New** and, on Gerrit, **To publish** (the
    newest review of a patchset not published yet), with counts, and **Hide
    outdated**: reviews of patchsets Gerrit moved on from, or of commit
    versions Gerrit no longer has. On Local, **Current branch** (on by
    default; its tooltip names the branch) shows only reviews of commits on the checked-out
    branch, with their older versions (same Change-Id); switched off, every
    branch of the repository shows. On Gerrit, **Hide published** hides the
    reviews of patchsets that already have a published AI review, from that
    review or another. On Gerrit a second row filters by the
    branches the reviews are for, when there are several. The choices are kept
    per tab.
  - **Keyboard and hover.** ↑ and ↓ move, Enter opens a review or a group, →
    and ← open and close a group, Esc closes the list. Every line has a hover
    card: on Gerrit the change, patchset and branch, whether Gerrit has a newer
    patchset, publication, findings by type, model, time and cost, and on a
    group its reviews by patchset; on Local the link to Gerrit instead, and on
    a group the commit's versions. The card waits 1.7 s on the chosen review
    and on a group's line, 1 s on a review inside a group.
  A tab without reviews shows the robot and "No local reviews
  yet" or "No Gerrit reviews yet", centered. After VS Code restarts, Local is open and no
  review is chosen; within a session each tab keeps its choice, and a new review
  opens its own tab. The **General information** card shows elapsed time, tokens,
  reported/estimated cost, model, Reasoning, Full/Light depth and nonzero finding
  categories. For a Gerrit review it also shows the change owner, the reviewed
  patchset as **PS** and the target branch. Owner and branch are remembered from
  the Gerrit patches list when the review starts; older reviews show only the
  patchset. There is no total Findings counter, animation, account limits or
  log button here. Every selected patch has its own history entry, statistics,
  NEW marker and Markdown report, even when started in a batch. The button opens
  only that patch's report. Batch totals are never copied to individual patches;
  missing per-patch measurements in older runs remain unavailable.
  Counts use the protocol's explicit `(defect)`, `(minor)`, `(suggestion)`,
  `(typo)`, `(style)` and `(nit)` labels; unlabeled comments appear as Other.
  Commit-message comments are also counted by their `/COMMIT_MSG` location,
  so that count overlaps the categories. Failed/incomplete batches do not
  appear clean; available counts are marked partial.
  **NEW** identifies unopened, available Markdown reports.
  **Only successful reviews of open work are kept.** A review that failed or
  was cancelled, every review of a Gerrit change that landed or was abandoned,
  and every review of a local commit that landed on the
  base branch (or whose change on that branch landed or was abandoned) is
  deleted with its files, not hidden, as soon as that is known. Each local
  commit is checked against the remote branch it was based on, not the one
  checked out now, so a backport with the Change-Id of a change landed on
  another branch keeps its reviews. A local commit
  not on Gerrit yet, or with another version there, keeps its reviews. In a batch only those reviews
  go; the others stay. A batch still shown on Review stays until Review lets it
  go, so its log can still be opened. Gerrit is asked once an hour, with one
  search for all reviewed changes; the Output channel names each deleted
  review and why. All-time usage statistics are kept.
  Completed patch reports from a partially cancelled batch remain available.
  Opening a report manually or automatically marks it read only after its files
  open successfully; a failed editor tab stays NEW. **Clear notifications** marks
  all available reports in open workspace repositories read and clears the
  Activity Bar badge, preserving reports and active reviews. These marks survive reload.
  **AI Settings → Clear history**, below Reset statistics with its own divider
  and description naming the repository, removes finished entries for the
  current repository from this list and acknowledges their notifications. It
  preserves active reviews, report files and MCP records; the cleared list stays
  cleared after reload.
  Older reports are considered read on first upgrade to notification tracking.
  Reports do not reopen on reload.
  The square diff icon left of **Open report results** or **Read report** opens
  the reviewed commit against its first parent in VS Code's multi-file diff
  editor, with every finding as a read-only comment thread under its line,
  labelled by category and signed like the report. The **Comments** panel
  follows the review chosen on the open Reports & History tab: it lists that
  review's findings by file, and empties for a review without findings or
  without a completed result, or when nothing is chosen. Clicking a finding
  there opens the reviewed version of its file at that line, read-only from
  Git, with or without the diff. Choosing another review also removes the
  previous findings from a diff still open for it; open its diff again to see
  them. For a Gerrit review the diff also shows other people's unresolved
  discussions on the reviewed patchset, read with `gc comments` when the diff
  opens: each with all its replies, labelled **Gerrit · unresolved**,
  read-only, and moved like a finding when it sits on hidden unchanged code.
  Threads started on other patchsets are left out, since their lines may have
  moved and owners do not always resolve them after a fix; copies of our own
  published findings are left out too. Gerrit is asked in parallel and never
  holds the diff back: a slow answer is added when it arrives, a failed one is
  only logged. This is for the diff only and never reaches a review, its
  prompts or its results. The arrow next to the icon chooses what the diff shows:
  **Files with comments** (the default, with their count) or **All changed
  files**. Choosing an option opens the diff and becomes what the icon opens,
  remembered per workspace. A review without findings always shows every file.
  The commit message comes first as `COMMIT_MSG`, in Gerrit's layout (parent,
  author and committer lines, then the message), so commit-message comments
  land on the same lines as in Gerrit; with Files with comments it appears only
  when it has comments. VS Code hides unchanged code, even under a comment,
  where Gerrit would unfold it. A finding on an unchanged line outside the
  visible context therefore moves to the nearest visible line of its file and
  starts with **Line N · unchanged code** and the quoted lines around it. A
  finding on a file the commit does not change goes on the message, quoting
  that file; one on a file absent from the commit goes there with its path.
  Files are read from Git objects, never from the working tree, so local edits
  and checkouts do not move comments. The reviewed commit must still be in the
  local repository: lreview fetches it for Gerrit reviews and it normally
  stays; if Git has pruned it, fetch the change again or rerun the review.
  Requires Git 2.24+.
  In a narrow panel the action buttons take one full-width row each, so
  their labels never wrap.
  The Gerrit tab offers **Read report** and **Publish to Gerrit** for the
  chosen patch. Publish to Gerrit is locked: click the lock inside the button
  to enable it. The lock closes again after a click, when another review is
  chosen and when the view reloads. Once published, the button reads
  **Published 16.10.26, 18:19** and stays disabled. Every confirmed publication
  is also recorded in a registry shared by all VS Code windows of this profile
  on this machine (`publications.json` in the extension's global storage). It
  is keyed by Gerrit project, change and patchset, not by folder, so two clones
  of one project in different windows see the same record. On first start it
  is filled from the review history of every workspace. A patchset gets one
  AI review: when another review, in this window or another, already published
  the same patchset, the button reads **Published** with that date and stays
  disabled, and the card says which signature published it. The extension
  also re-reads the registry right before publishing and refuses, so a
  publication made a moment ago in another window counts too. Reviews published from the CLI or another machine are not in the
  registry. Other people's AI reviews are read from Gerrit instead: when the
  report is shown (at most once a minute) the extension reads the change's
  comments, and an orange line under the button names each AI review of the
  reviewed patchset by someone else, or by your account outside this
  extension: author, date, signature and number of comments. It is a warning
  only; the button stays available. Publication invokes `lreview post` for exactly that result,
  sending the assessment and inline comments (or a no-issues message for a clean
  result), with no vote. Comments are pinned to the reviewed revision, even if
  a newer patchset exists. Gerrit CLI credentials and write access are required;
  its Python package must also be available to the lreview installation.
  Successful publication is remembered in the manifest and cannot be repeated
  by another click. Incomplete results cannot be published. A timeout or interrupted
  publication is marked uncertain and requires checking Gerrit before any manual retry.
  The configured signature, optionally including the reviewed model and reasoning, is
  captured when a review starts and inserted first under **Overall assessment**
  in its Markdown report, as plain text (reports signed in bold by earlier
  versions are converted when opened). The same signature prefixes published comments.
  Older reports capture a signature when first indexed or opened after upgrading.
- **General information:** the chosen report's card. Under the subject a
  strip shows the change: for a Gerrit review its number, the reviewed
  patchset (or `PS 8 → 9` when Gerrit has a newer one), an owner reply, owner
  and branch; for a local review the commit, its change on Gerrit (as the link
  icon in Local commits) and `since` for a re-review. The link icon in the
  corner opens the change; a Merge conflict chip marks a change Gerrit cannot
  merge, with gerrit-cli 0.2.45 or newer. The **Gerrit** row shows build, tests and
  Code-Review vote slots; **Found** the findings by kind (defect, minor,
  suggestion, typo, style, nit) and how many are in the commit message, as
  coloured dots with counts when the card is narrow. A review is outdated only
  when a newer patchset changes a file it found issues in: an orange note and
  edge say so and the file is marked. **Files with findings** lists those files;
  click one to open its diff with the review comments. A last line shows
  time, cost, tokens, model, reasoning and depth. Gerrit is read when the card
  is shown, at most once a minute (`gerrit info`; `gerrit diff` once per pair
  of patchsets); the review lists' last refresh is used when it has the change.
- **Status:** the Review header and VS Code status bar show gray when idle,
  blue while reviewing, green when a report is ready, and red on failure.
  The Activity Bar number is the count of NEW finished results in the open
  workspace repositories, rather than a generic status indicator. Its tooltip
  lists dates and commit subjects. Clicking the status bar selects the newest
  unread result in Reports & History when no review is running. VS Code's public API
  does not support dynamically coloring parts of that static container icon.
- **Button tooltips:** Cancel shows **🌍 Save nature**, Start review explains
  the Lustre protocol, and the log icon shows **Open the review log in the Output panel.**
  immediately on hover or keyboard focus. The square log button has a blue outline.
- **Cancel:** outlined in red. Sends SIGINT to lreview so its existing cancellation handler
  stops reviewer process groups and saves partial results. Closing VS Code
  also requests cancellation. After an abrupt crash, an unfinished saved
  run is shown as interrupted, never as a clean review.

Only one batch runs per extension instance; the default is two parallel
commit reviews inside the batch. Publishing requires a separate click in Reports & History. Run files
live in VS Code's extension workspace storage, outside the source checkout.
They remain there until removed manually; no automatic retention cleanup runs.

## Models and authentication

This version supports **Codex, Claude Code, and Augment (Auggie)**. It obtains models and
reasoning options dynamically from the selected installed client:
Codex's [`app-server` / `model/list`](https://developers.openai.com/codex/app-server),
or Claude Code's streaming SDK initialization catalog. Claude discovery
sends only an initialization control request, with hooks and MCP disabled;
it sends no user prompt. Older Claude clients without a catalog need updating.
Augment uses the official `auggie models list --json` catalog and `auggie --print`
backend. It does not access the Augment extension's private authentication
storage. Use **AI Settings → Auggie → Sign in** to authenticate the CLI.
It does not hard-code a model list or read another extension's private UI
state, and it does not mirror the model currently selected in an agent chat.
The sidebar remembers each agent's model and reasoning selection separately.
Providers exposed by VS Code's separate Language Model API are not review
backends in this version.

Connection checks use `codex login status`, `claude auth status --json`, and
`auggie account status --json`. They are asynchronous, bounded, and never
start inference. Raw status output and credentials are not shown or stored.
Checks refresh while settings are visible, after returning from the browser,
and during sign-in. An unavailable check is shown as unknown, not signed out.
Logout affects that CLI's shared credentials; environment or managed credentials
may keep it authenticated, so status is always checked again after logout.

The selected agent handles authentication using its normal configuration. The extension
does not copy tokens or ask for a separate API key. Listing models starts no
inference turn; reviewing consumes the selected model's normal usage.
The client catalog is not a guarantee of account access.
Codex must support `exec` and `app-server`; Claude Code must support print
mode and streaming control initialization.

Token counters use agent usage events. For Codex, the extension follows only
the session whose thread id was emitted by this review, under
`$CODEX_HOME/sessions` (default `~/.codex/sessions`); if session telemetry is
unavailable, tokens appear when `codex exec` emits its final usage. Claude
usage is deduplicated by message id. Cached Codex tokens are not added twice.
Missing usage or prices are shown as unavailable, never as zero. A partial
counter is marked `≥`.

- **Augment:** read only the session id identified in that review worker's log,
  under `~/.augment/sessions`. Its token usage and billing metadata update
  throughout the review. Deduplicate requests and billing transactions;
  retain prior totals across history compaction. Child-agent tokens and compacted
  history that cannot be fully accounted for make the count partial.
  Final billing remains authoritative; credits are never converted to USD.
  Saved reviews with missing tokens are enriched when their session still exists.
- **Claude:** receive its [OpenTelemetry cost counters](https://code.claude.com/docs/en/monitoring-usage)
  once per second through a temporary localhost HTTP endpoint with a random
  path. Only review children receive this configuration; the collector is
  closed when the batch ends. It retains numeric counters, not raw telemetry,
  prompts or credentials. It enables the metrics exporter for those processes,
  disables logs/traces exporters and does not edit user or managed settings.
  Managed policies can prevent local telemetry; in that case the final client
  result still supplies cost. **Est. cost** is Claude's API cost estimate,
  not an extra subscription charge.
- **Codex:** **API estimate** uses per-request token deltas and standard
  [API text-token rates](https://developers.openai.com/api/docs/pricing), checked
  2026-10-15, for GPT-6.1 Sol, GPT-6 Astra, Sol and Luna. It handles cached input
  and the long-context multiplier per request. It excludes cache-write charges,
  tools and speed/region premiums. It is not a subscription invoice. Unknown
  model prices remain unavailable; the pricing table lives in `src/pricing.js`.

**Account limits** are shown before the first review and independently of
review statistics. While Review is visible, the selected agent's limits are
requested at most once per minute, without sending an inference prompt:
Codex uses [`account/rateLimits/read`](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt);
Claude Code uses its installed client's experimental `get_usage` control
request, with hooks and MCP disabled. Older Claude clients may not support it;
failed refreshes retain labelled last-known data. Credentials remain with the
clients, and no user configuration or status-line hooks are installed.

Review usage events also update the snapshot: Codex session
`token_count.rate_limits` and Claude `rate_limit_event.unifiedWindows`.
The meter shows **percent remaining** (`100 − used`) and time to reset.
Its shade changes in ten-percentage-point steps: green at 70–100%, yellow
at 40–<70%, orange at 20–<40%, and red below 20%.
The window length comes from the client: primary does not always mean 5 hours,
and some accounts expose only a weekly limit. Parallel reviews share account
limits; percentages are never summed. The snapshot's age and refresh failures
are visible. Expired windows disappear until fresh data arrives. A missing
limit is not treated as unused quota. Augment shows no account quota meter
because this integration has no supported quota query for it.

The full and light prompts are unchanged. The extension passes
`LREVIEW_PROMPTS_UPDATE=off` to keep a review from updating the prompt checkout
silently; update that checkout explicitly when needed.

## Let an agent use it for self-review

1. Open **AI Settings → Self-review via MCP** and click **Connect Codex**,
   **Connect Claude Code**, or **Connect Auggie CLI**. The corresponding CLI
   must be installed; a missing CLI disables its button. The repository is
   the one selected in Commits.
2. The extension registers `lreview_vscode` using that client's MCP commands.
   No configuration document needs to be copied. Reconnecting updates this
   server while retaining unrelated settings; Claude restores its old entry
   if a replacement fails. A successful write is shown as **Configured**.
   Saved settings are checked again after reopening VS Code, entering settings,
   returning to the window or clicking Refresh connections. A matching entry
   shows a green check and a disabled **… configured** button without another
   click. Connections pointing to a different window, disabled entries, outdated
   paths and check failures have distinct messages. This verifies configuration,
   not whether an existing agent chat has already loaded the MCP tools.
3. Start a new chat/session in that agent and keep this trusted VS Code window
   open. Ask it to list repositories through `lreview_vscode` and verify the
   expected Lustre checkout before requesting a review. The client can still
   require its normal MCP trust or tool-use approval. Existing chats may need
   a restart to discover the tools.

Connection scope follows each client's supported configuration commands:

- **Codex:** `codex mcp add` saves the user-wide entry in
  `$CODEX_HOME/config.toml` (normally `~/.codex/config.toml`). CLI and IDE share
  this configuration ([OpenAI documentation](https://developers.openai.com/codex/mcp)).
  This entry points to the connected VS Code workspace. Connecting Codex from
  a different window replaces that endpoint; it does not connect every window
  at once. Other MCP server entries are preserved.
- **Claude Code:** `claude mcp add-json --scope local` stores a private entry
  for the selected repository in the client's personal configuration
  ([Claude documentation](https://code.claude.com/docs/en/mcp#local-scope)).
  It is available to Claude Code in that project, not all other projects.
- **Auggie CLI:** `auggie mcp add-json --local --replace` writes the selected
  repository's `.augment/settings.local.json`, using the installed CLI's
  local-scope option ([Auggie MCP documentation](https://docs.augmentcode.com/cli/integrations)).
  This connects Auggie CLI; it does not configure the separate Augment IDE
  extension's MCP settings. Keep the local file out of version control.
  Auggie starts an MCP server through a shell that splits its path at
  spaces, and VS Code's paths have them (`Visual Studio Code.app`,
  `Application Support`). The entry therefore starts a small launcher,
  `~/.augment/lustre-review/mcp-<id>.sh`, which runs the same server with
  the quoted paths. A saved entry from an older version, with the paths
  themselves, shows as needing a reconnect.

The bridge uses VS Code's runtime, so it does not need a separate Node
installation. Connections write no API keys and start no review. A closed VS
Code workspace cannot serve tools. If the same workspace is open in several
windows, the most recently activated window owns the connection.

The Command Palette also provides **Connect Codex/Claude/Auggie for Self-Review**.
**Lustre Review Helper: Show Codex MCP Configuration** remains available as a manual
fallback and only opens the suggested TOML snippet.

Available tools:

| Tool | Purpose |
| --- | --- |
| `list_repositories` | Open workspace repositories and their ids |
| `list_commits` | Recent commits, newest first; each with a Change-Id has `gerrit`: its change, `link` (current, outdated, merged, abandoned or none) and `merge_conflict` |
| `list_models` | Models and efforts for `agent: "codex"` (default), `"claude"`, or `"auggie"` |
| `start_review` | Start with the chosen `agent` and `model`; returns a job id immediately. `since` re-reviews one commit against the commit reviewed before |
| `get_review` | Status, findings (file, line, message), assessment and errors; `progress` per commit while a batch runs; once finished, `reports` with each commit's `gerrit_state`; `include_log: true` adds the last 20,000 characters of the log |
| `find_reviews` | Earlier reviews of commits, by SHA, branch or other ref, by `subject` text, or by Gerrit `change` (number or URL); the newest match carries `gerrit_state` |
| `get_selected_review` | The review chosen in Reports & History, with findings, report file and `gerrit_state` |
| `get_gerrit_queue` | The Waiting Review and In progress lists of Gerrit patches: per change its state since my review, CI, votes, ready for landing, and this extension's or other people's AI reviews; `refresh: true` reads Gerrit again |
| `list_reviews` | Recent runs, including sidebar runs |
| `cancel_review` | Stop a running review |

**Fixing findings with an agent.** Ask in plain words, for example "we
reviewed the patch on this branch, fix the findings and review it again". The
server's instructions tell the agent the path:

1. `find_reviews` without `commits` looks up the current branch's commits that
   are not yet on its remote base branch, the same base Show merged uses: the
   local patch or the whole series, else HEAD. Name a SHA, branch or subject
   to look up something else. A commit matches its own review and the reviews
   of its earlier versions with the same Change-Id, so amending or rebasing
   does not lose them; Gerrit reviews of the same change are found the same
   way. The newest match per commit carries its assessment and findings.
   `get_selected_review` returns the review chosen in the sidebar instead.
2. The agent fixes the code and amends the commit.
3. `start_review` for that commit with `since` set to the earlier review's
   `reviewed_commit` passes lreview's `--since`, so only what changed since
   then is reviewed (for exactly one local commit). If nothing changed, as
   `git range-diff` sees it, the call refuses instead of starting a review.

`gerrit_state` is what General information shows. For a Gerrit patch: the
reviewed and current patchset, the files a newer patchset changed and
`findings_may_be_outdated` when they include a file with findings, merge
conflict, CI and Code-Review votes, whether this review was published, and
other people's AI reviews of the same patchset. For a local commit: its
change's `link`, CI and votes. Gerrit is read at most once a minute per
report, as in the sidebar, and a slow answer is reported as such instead of
holding the agent.

Agents review and fix local commits only: nothing here uploads, publishes or
votes on Gerrit.

Example instruction for the agent, also suitable for the project's `AGENTS.md`:

```text
After committing a patch, use the lreview_vscode MCP server for an
independent Lustre review. List repositories and models, then call
start_review for the exact commit SHA, chosen agent and model. Poll get_review
until it completes (wait between polls). Examine and verify its findings;
do not treat failed, cancelled, or interrupted runs as approval. Do not
publish comments. Inside a review worker, perform the review directly:
never start another lreview review.
```

Runs started through MCP appear in the same panel. The MCP server exposes
only repositories open in that VS Code workspace. Communication uses a
local Unix socket and a per-session secret, both stored with owner-only
permissions. A worker blocks this MCP server's tools and sets a recursion guard.
Codex can request a Claude review through MCP by passing `agent: "claude"`
to both `list_models` and `start_review`; it need not use its own model.

## Languages

The panel speaks English, German (Deutsch), Spanish (Español), Japanese
(日本語), Simplified Chinese (简体中文) and Russian (Русский). AI Settings →
Language (the translate icon) lists them with their flags. **Automatic**, the
default, follows the display language of VS Code: Chinese of any kind gets
Simplified Chinese, a language not on the list gets English. Choosing a
language saves `lustreReview.language` for all windows and redraws the panel
at once; Automatic clears the setting again.

Everything the panel shows is translated, with each language's plural forms
and date order, and so are the messages and errors of the extension. The
names of settings and commands follow the display language of VS Code, as
VS Code shows them. Signatures and comments published to Gerrit, the review
reports, the Output log and the MCP answers to agents stay in English.

Translations live in `l10n/<language>.json`, keyed by the English text; a
plural is an object of its forms (`one`, `few`, `many`, `other`). Code marks a
text with `t('…')`, or `tn(count, 'one …', 'other …')` for a plural, in
`src/` and in `media/review.js`; the panel's HTML is translated as a whole.
`node test/l10n-keys.js` lists every text, and `test/l10n.test.js` fails when a
language lacks one, has one nothing uses, or changes a `{placeholder}`.

## Settings

| Setting | Default | What it sets |
| --- | --- | --- |
| `lustreReview.language` | `auto` | Language of the panel; `auto` follows VS Code |
| `lustreReview.lreviewPath` | found on `PATH` | Path to `lreview` |
| `lustreReview.codexPath` | Codex extension, then `PATH` | Path to Codex |
| `lustreReview.claudePath` | Claude Code extension, then `PATH` | Path to Claude Code |
| `lustreReview.auggiePath` | found on `PATH` | Path to the Auggie CLI |
| `lustreReview.gerritPath` | beside lreview, then `PATH` | Path to gerrit-cli |
| `lustreReview.gerritDashboardPath` | beside lreview and gerrit-cli | Path to gerrit-dashboard |
| `lustreReview.gerritBotName` | empty: `AI review` | Name in signatures of reports and comments |
| `lustreReview.gerritSignatureDetails` | off | Add model and reasoning to the signature |
| `lustreReview.gerritPatchesLayout` | `list` | `list`, `cards` or `groups` |
| `lustreReview.promptsDir` | lreview's own discovery | A review-prompts checkout |
| `lustreReview.commitLimit` | `30` | Commits listed (1 to 200) |
| `lustreReview.jobs` | `2` | Reviews run at the same time in a batch |
| `lustreReview.timeout` | `7200` | Seconds per commit |
| `lustreReview.mode` | `full` | `full` (deep dive) or `light` |

The extension requires Workspace Trust because the existing lreview
backend runs agent tools with its existing unattended permission flags.
Review only code you are comfortable letting that backend inspect and run.

## Troubleshooting

<details>
<summary><b>Start review is greyed out</b></summary>

Hover it: the tooltip says what is missing, such as a repository, lreview, a
signed-in agent or a model. AI Settings marks the tab with the fix with a yellow
dot.
</details>

<details>
<summary><b>lreview, gerrit-cli or an agent is not found</b></summary>

VS Code may not see the `PATH` of your shell. Set the matching path setting
(`lustreReview.lreviewPath`, `gerritPath`, `codexPath`, `claudePath` or
`auggiePath`) to the absolute path of the executable, then press **Refresh
connections**.
</details>

<details>
<summary><b>A private Gerrit change cannot be read or reviewed</b></summary>

The Gerrit API needs gerrit-cli's account: open **AI Settings → Utilities →
Open Gerrit CLI configuration**, set `GERRIT_USER` and `GERRIT_PASS` (an HTTP
password from Gerrit's settings), then **Check connection**. Fetching the
commit also needs Git access to the project through your SSH key or credential
helper.
</details>

<details>
<summary><b>Waiting Review and In progress are empty or missing</b></summary>

They need `gerrit-dashboard` and a working gerrit-cli login. The tab says what is
wrong and offers the fix as a button.
</details>

<details>
<summary><b>The agent over MCP does not see the tools</b></summary>

Start a **new** chat after connecting, keep this VS Code window open, and check
that the MCP tab shows the agent as configured for this window.
</details>

## Development

See [CONTRIBUTING.md](../CONTRIBUTING.md): building, tests, the layout of the code and
translations.
