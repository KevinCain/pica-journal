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

## Needs

- Claude Code signed in with claude.ai (Pro or Max) or a Console API key. Team and Enterprise: an Owner must turn
  on Channels in the organization's Claude Code settings.
- Node 18 or later.
- pica in Chrome or Edge on a desktop.

## What leaves your computer

The items you send and the sheets Claude opens go to Anthropic under your Claude account's terms. pica's server
never sees the journal.
