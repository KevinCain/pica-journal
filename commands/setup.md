---
description: Set up the pica journal here, in a writer's folder or a code project (checks, then asks before each change)
---

Set up the pica journal for this session's folder or project. Do each step in order and report briefly.

1. Find the journal: run `pica-journal where`. It prints `journal <folder>`, `project <folder>` and `state`.
   - `state ready`: pica has written there already. Go on.
   - `state empty`: the folder exists and pica has not written to it yet. Go on.
   - `state missing`: say where the journal will be (`<project>/journal` in a code project) and run
     `pica-journal init` to make it.
2. In a git project, if the journal folder is inside it, run `git check-ignore -q <journal folder>`. If it is not
   ignored, ask the writer which they want, recommending the first:
   - keep the journal out of git: add `/journal/` to the project's `.gitignore` (its sheets are the writer's
     notes and Claude's replies, private to this computer);
   - commit it, so the project's history keeps the conversation.
   Change `.gitignore` only on a clear answer.
3. Check Node: `node --version` must be 18 or later.
4. Propose the allowlist, so Claude runs the journal command without asking each time and nothing else:

   ```json
   { "permissions": { "allow": ["Bash(pica-journal:*)"] } }
   ```

   In a code project, offer `.claude/settings.local.json` (just this computer) or `.claude/settings.json` (shared
   with everyone who works on the project); in a writer's folder, `.claude/settings.json`. Only on a clear yes,
   merge it into that file (keep every other setting) and show the result.
5. Say what to choose in pica (drawer → Journal → Choose folder): in a code project, the project folder (pica
   uses its `journal/` folder) or the journal folder itself; for a writer, the folder Claude runs in.
6. Say how to start listening from now on, from anywhere in the project:
   `claude --dangerously-load-development-channels plugin:pica-journal@pica`
   (a shell alias saves typing it), and that a `.listening` file in the journal tells pica a session is waiting.
7. If the state was `ready`, run one journal pass now (the `journal` skill).
