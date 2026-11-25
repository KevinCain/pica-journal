// Where the journal is, for the command and the channel alike.
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

// Claude's memory for this journal: one folder, recorded once by `pica-journal memory <folder>` (IMPORT-PLAN §3).
// Claude Code keeps a memory folder per folder a session starts in; a project whose sessions mostly start in the
// folder above it has its memories there. The setting, in the journal folder's `.memory`, names that folder (the
// project or a folder above it); mirror, adopt, forget and remember all use it. $CLAUDE_MEMORY_DIR overrides it.
export const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
/** the memory folder Claude Code keeps for sessions started in `folder` */
export const memoryOf = (folder) => path.join(CLAUDE_DIR, 'projects', path.resolve(folder).replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
export const MEMORY_SETTING = path.join(DIR, '.memory');
/** the folder whose memory the journal uses: the recorded one, else the project */
export function memoryFolder() {
  try { const f = JSON.parse(fs.readFileSync(MEMORY_SETTING, 'utf8')).folder; if (typeof f === 'string' && path.isAbsolute(f)) return f; } catch {}
  return ROOT;
}
export const MEM = path.resolve(process.env.CLAUDE_MEMORY_DIR || memoryOf(memoryFolder()));
