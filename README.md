# pica-journal

Claude's side of the journal in [pica](https://picaimprint.app/journal). Mark an item ☞ in pica, and a running
Claude Code session answers it under the item, in your own folder.

## Install (once)

```
claude plugin marketplace add KevinCain/pica-journal
claude plugin install pica-journal@pica
```

## Each session

```
cd <the folder you chose in pica>
claude --dangerously-load-development-channels plugin:pica-journal@pica
```

Then, the first time, `/pica-journal:setup`.

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
