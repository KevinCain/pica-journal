---
description: Set up this folder for the pica journal (checks, then a one-line allowlist after asking)
---

Set up the current folder as the writer's pica journal. Do each step in order and report briefly.

1. Check the folder: run `pica-journal sheets`. If it fails or the folder has neither `sheets/` nor
   `outbox.jsonl`, say the writer should start Claude in the folder they chose in pica
   (drawer → Journal → Choose folder), and stop.
2. Check Node: `node --version` must be 18 or later.
3. Propose the allowlist. Show the writer exactly this, for `.claude/settings.json` in this folder:

   ```json
   { "permissions": { "allow": ["Bash(pica-journal:*)"] } }
   ```

   Explain in one sentence: it lets Claude run the journal command without asking each time; nothing else.
   Ask whether to write it. Only on a clear yes, merge it into any existing `.claude/settings.json`
   (keep every other setting) and show the result.
4. Say how to start listening from now on:
   `claude --dangerously-load-development-channels plugin:pica-journal@pica`
   and that a `.listening` file in the folder tells pica a session is waiting.
5. Run one journal pass now (the `journal` skill).
