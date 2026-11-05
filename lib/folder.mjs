// Where the journal is, for the command, the channel and the Stop hook alike.
//
//   1. $PICA_JOURNAL, if set.
//   2. The folder Claude runs in, when it is a journal (it holds sheets/ or outbox.jsonl): a writer runs Claude
//      in the folder they chose in pica.
//   3. In a code project, <project>/journal: the project is $CLAUDE_PROJECT_DIR, or the nearest folder up that
//      holds .git, so a session started in <project>/src finds the same journal.
//   4. Otherwise the folder Claude runs in, if it holds nothing yet but dotfiles (Claude started before pica
//      first wrote), else ./journal.
//
// ROOT is the project the session belongs to (the .git folder, else where Claude started): Claude Code keeps
// that project's memory under its path.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const isJournal = (d) => fs.existsSync(path.join(d, 'sheets')) || fs.existsSync(path.join(d, 'outbox.jsonl'));

/** the nearest folder from d up that holds .git, never the home folder or above it */
export function gitRoot(d) {
  const home = os.homedir();
  for (let at = path.resolve(d); ; at = path.dirname(at)) {
    if (at === home || at === path.dirname(at)) return null;
    if (fs.existsSync(path.join(at, '.git'))) return at;
  }
}

function resolve() {
  const start = path.resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  const project = gitRoot(start);
  const root = project ?? start;
  if (process.env.PICA_JOURNAL) return { dir: path.resolve(process.env.PICA_JOURNAL), root };
  if (isJournal(process.cwd())) return { dir: process.cwd(), root };
  if (isJournal(start)) return { dir: start, root };
  if (project) return { dir: path.join(project, 'journal'), root: project };
  let fresh = false;
  try { fresh = !fs.existsSync(path.join(start, 'journal')) && fs.readdirSync(start).every((n) => n.startsWith('.')); } catch {}
  return { dir: fresh ? start : path.join(start, 'journal'), root: start };
}

export const { dir: DIR, root: ROOT } = resolve();
