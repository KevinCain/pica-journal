# pica-journal

Claude's side of the journal in [pica](https://picaimprint.app/journal). Mark an item ☞ in pica, and a running
Claude Code session answers it under the item, in your own folder.

## Install (once)

```
claude plugin marketplace add KevinCain/pica-journal
claude plugin install pica-journal@pica
```

## Each session

In a writer's folder, start Claude in the folder you chose in pica. In a code project, start it anywhere in the
project: the journal is the project's `journal/` folder.

```
cd <the folder you chose in pica, or your project>
claude --dangerously-load-development-channels plugin:pica-journal@pica
```

Then, the first time, `/pica-journal:setup`. It makes `journal/` in a project if it is not there yet, asks
whether git should ignore it, offers the one-line allowlist, and says what to choose in pica (drawer → Journal →
Choose folder): in a project, the project folder.

To type less, add an alias to your shell's startup file:

```
alias claude-journal='claude --dangerously-load-development-channels plugin:pica-journal@pica'
```

`pica-journal where` shows which folder a session uses. `PICA_JOURNAL=<folder>` points it anywhere else.

Channels are a Claude Code research preview: the flag is needed until this plugin is on Anthropic's allowlist.
The channel only announces *how many* entries arrived, never their text; Claude reads them with
`pica-journal pending`, and treats only the items you sent with ☞ as instructions.

## References to code

In a code project a reply can point at the code instead of quoting it (`reply --ref src/app.ts#render`, up to
three). The reply carries a snapshot of at most 12 lines; when you open the reference in pica, the running
session's channel reads the lines as they are now and follows them through edits since, using `git diff`. It
never reads `.env` files, key files, git-ignored files or anything under `.git`, and refuses an excerpt that
looks like it holds a key. `pica-journal resolve <reply-id> <n>` shows what pica would be shown.

## Importing a project

**Journal ▸ Import your project…** in pica asks Claude to distil the project into a few essays and an index,
never a catalog of the code. Claude first runs `pica-journal survey`, which weighs the git history by what still
survives at HEAD (blame without whitespace, following moves; the journal, lockfiles, generated, vendored, binary
and large data files left out), groups it into threads, and counts removals and reverts as decisions too. Claude
then proposes a plan sheet, one step for each essay; you send the steps you want with ☞, or Approve all steps.

The survey also reads how the project runs, from the files at HEAD alone (no live service is read): the
environment variables the code reads (names, never values), deploy configs, workflows and their schedules, deploy
scripts, migrations, the services the code calls, its skills and agent configs, and seeded test logins (by role).
A literal key committed to a tracked file is reported at the top, by file and name. It ranks the project's
documents by what they are about (pricing, pilots, operations, decisions…), and weighs signals for rules and
questions: files that always change together, security fixes, TODOs and commit messages that leave something to
decide. From these the plan offers sheets the project keeps across imports: Infrastructure, Credentials and
access (where each credential is kept and who can recover it, never the credential), How we work, technical and
commercial questions, and rules kept by hand, each written to Claude's memory only once you ✓ it. A
`leave-out.txt` in the journal folder (one word a line) keeps out any document, session or memory naming one.

Reading Claude Code's own transcripts of the project is your choice at each import. When you choose it, the
survey keeps only your words, Claude's answers and each session's last summary, and takes out email addresses,
phone numbers, street addresses, keys and tokens before Claude reads any of it. The survey's cache (each file's
blame, the transcript index and the filtered sessions) is kept in the plugin's data folder (`$CLAUDE_PLUGIN_DATA`,
else `~/.cache/pica-journal`), never in the journal. Claude Code clears sessions older than `cleanupPeriodDays`
(30 by default), so only recent conversations can be read.

Nothing that looks like a key, token or password is written to the journal: every command that writes refuses it,
naming the line, and a memory file holding one is not mirrored.

Claude Code keeps memory per folder a session starts in. The journal uses one, recorded at setup with
`pica-journal memory <folder>` (the project, or a folder above it where its sessions start).

## Refactoring a sheet

A long sheet can be rewritten in place as an essay (`pica-journal rewrite`, offered as **Refactor this sheet**, never
run unasked). The sheet keeps its id, its pins, every open item and every answered one you have not yet ✓'d or ✗'d; the writer's own words are kept as they are or
left out, never retyped; and the sheet as it was goes to pica's Archive, linked from the new one. pica refuses the
rewrite if the sheet changed since Claude read it or an ask on it is waiting. A link to an item,
`sheet:<id>#<item>`, opens it even after a rewrite folded it away, in the archived copy.

## Needs

- Claude Code signed in with claude.ai (Pro or Max) or a Console API key. Team and Enterprise: an Owner must turn
  on Channels in the organization's Claude Code settings.
- Node 18 or later.
- pica in Chrome or Edge on a desktop.

## What leaves your computer

The items you send and the sheets Claude opens go to Anthropic under your Claude account's terms. pica's server
never sees the journal.
