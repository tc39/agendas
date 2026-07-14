#!/usr/bin/env node

// Checks that changes to the "Proposals" table of an agenda document do not
// violate its ordering rule: sorted primarily by stage (descending),
// secondarily by timebox (ascending), and finally by insertion date.
//
// Problems are reported as GitHub workflow-command annotations (::error /
// ::warning), which render inline on the PR diff. Exit codes:
//   0  ran cleanly, or found only advisory ordering problems
//   1  found error-severity ordering problems and --strict was passed
//   2  could not run: bad usage, an unresolvable ref, an unreadable file, or
//      a changed agenda document with no proposals table to check
// Ordering problems do not fail the check by default so that we can gain
// confidence in the absence of false positives before passing --strict to
// block merging. A missing proposals table is not an ordering problem but a
// failure to run — the table was renamed, moved, or its structure drifted
// enough to break matching — so it always exits non-zero, --strict or not.
//
// The check is diff-aware: it compares against a base commit so that
//   - violations already present in the base branch are tolerated (they are
//     never forced to be cleaned up; only violations introduced by the change
//     under review are reported), and
//   - the insertion-date rule can be enforced: it is not recorded in the
//     table, so it only manifests as the relative order of rows sharing a
//     stage and timebox. Newly added rows must come after pre-existing ones.
//
// Rows with a non-numeric stage (e.g. "N/A") or an unparseable timebox are
// unconstrained on that key. A renamed agenda document is treated as brand
// new, so a grandfathered violation in it would resurface.
//
// Usage: node ./scripts/check-proposals-order.mjs --base <ref> [--head <ref>] [--strict] [files...]
//   --base    base branch commit; the comparison point is `git merge-base
//             <base> <head>`, i.e. the fork point
//   --head    commit whose file contents to check; defaults to the working tree
//   --strict  exit 1 if any error-severity ordering problem is found
//   files     repo-relative agenda paths; defaults to the agenda documents
//             changed between base and head
//
// Example: node ./scripts/check-proposals-order.mjs --base origin/main

import { execFileSync } from 'child_process';
import fs from 'fs';
import { pathToFileURL } from 'url';

const HEADER_CELLS = ['stage', 'timebox', 'topic', 'presenter'];
const AGENDA_PATH_PATTERN = /^\d{4}\/\d{2}\.md$/;

// annotation severity per problem kind. For ordering violations this is
// presentational, since they only fail CI under --strict; reordering rows of
// equal stage and timebox may be a deliberate correction of a past mistake,
// which the check cannot distinguish, so it only warrants a warning.
const SEVERITY = {
  stage: 'error',
  timebox: 'error',
  insertion: 'error',
  reorder: 'warning',
  'missing-table': 'error',
};

// kinds that mean the check could not run against a file rather than that it
// found a violation; these fail the run unconditionally, even without --strict
const RUN_FAILURE_KINDS = new Set(['missing-table']);

// ---------- parsing ----------

// splits a `| a | b |` table line into trimmed cell contents, respecting
// escaped pipes and GFM's optional trailing pipe
export function splitCells(line) {
  const trimmed = line.trim();
  const cells = trimmed.split(/(?<!\\)\|/);
  // the leading pipe produces an empty first element
  cells.shift();
  if (trimmed.endsWith('|')) cells.pop();
  return cells.map(cell => cell.trim());
}

export function parseStage(cell) {
  return /^\d+(\.\d+)?$/.test(cell) ? parseFloat(cell) : null;
}

// timebox in minutes, e.g. "30m", "1h", "1h30m"
export function parseTimebox(cell) {
  const match = /^(?:(\d+)h)?(\d+)m$|^(\d+)h$/.exec(cell);
  if (match == null) return null;
  if (match[3] != null) return Number(match[3]) * 60;
  return (match[1] == null ? 0 : Number(match[1]) * 60) + Number(match[2]);
}

// the first link URL in the topic cell, used to re-identify a row whose text
// was edited (e.g. a slides link was added)
function firstTopicUrl(cells) {
  const match = /\]\(\s*<?([^)>\s]+)/.exec(cells[2] ?? '');
  return match?.[1];
}

// finds every proposals table: a `| stage | timebox | topic | presenter |`
// header (the only 4-column table in an agenda) followed by a delimiter row
export function parseProposalsTables(contents) {
  const lines = contents.replace(/\r\n/g, '\n').split('\n');
  const tables = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^\s*\|/.test(lines[i])) continue;
    const headerCells = splitCells(lines[i]).map(cell => cell.toLowerCase());
    if (headerCells.length !== HEADER_CELLS.length) continue;
    if (!HEADER_CELLS.every((cell, k) => headerCells[k] === cell)) continue;
    if (!/^\s*\|/.test(lines[i + 1])) continue;
    if (!splitCells(lines[i + 1]).every(cell => /^:?-+:?$/.test(cell))) continue;
    const rows = [];
    let j = i + 2;
    for (; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
      const cells = splitCells(lines[j]);
      rows.push({
        line: j + 1, // 1-based
        text: lines[j].trim(),
        cells,
        stage: parseStage(cells[0] ?? ''),
        timebox: parseTimebox(cells[1] ?? ''),
        url: firstTopicUrl(cells),
      });
    }
    tables.push({ rows });
    i = j - 1;
  }
  return tables;
}

// ---------- ordering checks ----------

// all pairwise stage/timebox violations, so that a row with an unparseable
// key sitting between two others cannot mask a violation across it
export function findStaticViolations(rows) {
  const violations = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const earlier = rows[i];
      const later = rows[j];
      if (earlier.stage == null || later.stage == null) continue;
      if (earlier.stage < later.stage) {
        violations.push({ kind: 'stage', i, j });
      } else if (
        earlier.stage === later.stage
        && earlier.timebox != null && later.timebox != null
        && earlier.timebox > later.timebox
      ) {
        violations.push({ kind: 'timebox', i, j });
      }
    }
  }
  return violations;
}

// pairs head rows with base rows: exact text first, then first topic link URL
// (rows are routinely edited to add slides links); greedy and in document
// order, so duplicates resolve deterministically
export function matchRows(baseRows, headRows) {
  const headToBase = new Array(headRows.length).fill(null);
  const baseUsed = new Array(baseRows.length).fill(false);
  for (const matches of [
    (baseRow, headRow) => baseRow.text === headRow.text,
    (baseRow, headRow) => headRow.url != null && baseRow.url === headRow.url,
  ]) {
    for (let h = 0; h < headRows.length; h++) {
      if (headToBase[h] != null) continue;
      for (let b = 0; b < baseRows.length; b++) {
        if (baseUsed[b] || !matches(baseRows[b], headRows[h])) continue;
        headToBase[h] = b;
        baseUsed[b] = true;
        break;
      }
    }
  }
  return headToBase;
}

// head violations minus those already present between the same two rows in
// the base table: pre-existing problems are not this change's fault, but a
// row whose stage/timebox was edited into violation is
export function findNewStaticViolations(baseRows, headRows, headToBase) {
  const baseViolations = new Set(
    findStaticViolations(baseRows).map(v => `${v.kind}:${v.i}:${v.j}`),
  );
  return findStaticViolations(headRows).filter(({ kind, i, j }) => {
    if (headToBase[i] == null || headToBase[j] == null) return true;
    return !baseViolations.has(`${kind}:${headToBase[i]}:${headToBase[j]}`);
  });
}

// enforces the insertion-date tiebreak within each group of head rows sharing
// a (stage, timebox); these violations are inherently caused by the change
// under review, so no suppression pass is needed
export function findInsertionViolations(baseRows, headRows, headToBase) {
  const violations = [];
  const groups = new Map();
  for (let h = 0; h < headRows.length; h++) {
    const { stage, timebox } = headRows[h];
    if (stage == null || timebox == null) continue;
    const key = `${stage}:${timebox}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }
  for (const group of groups.values()) {
    // rows that were already in this same group in the base table; a matched
    // row whose stage or timebox changed has an unknowable position among its
    // new peers, so it is exempt from the checks below
    const existing = group.filter(h => {
      const b = headToBase[h];
      return b != null
        && baseRows[b].stage === headRows[h].stage
        && baseRows[b].timebox === headRows[h].timebox;
    });
    // existing rows must keep their base order: it records insertion date
    for (let x = 0; x < existing.length; x++) {
      for (let y = x + 1; y < existing.length; y++) {
        if (headToBase[existing[x]] > headToBase[existing[y]]) {
          violations.push({ kind: 'reorder', i: existing[x], j: existing[y] });
        }
      }
    }
    // new rows were inserted last, so they must come after existing ones
    for (const h of group) {
      if (headToBase[h] != null) continue;
      for (const e of existing) {
        if (e > h) violations.push({ kind: 'insertion', i: h, j: e });
      }
    }
  }
  return violations;
}

// ---------- reporting ----------

// pairwise checks produce a violation per pair, which is noisy: one misplaced
// row against four neighbours is four pairs. Anchor each pair on its likelier
// culprit and merge pairs sharing an anchor into one message.
function coalesceViolations(violations, baseRows, headRows, headToBase) {
  const changed = h => {
    const b = headToBase[h];
    return b == null
      || baseRows[b].stage !== headRows[h].stage
      || baseRows[b].timebox !== headRows[h].timebox;
  };
  const grouped = new Map();
  for (const { kind, i, j } of violations) {
    // anchor the added/edited row of the pair; when neither or both qualify,
    // fall back to the later row (insertion/reorder pairs already put the
    // culprit first)
    let anchor = i;
    let other = j;
    if ((kind === 'stage' || kind === 'timebox') && !(changed(i) && !changed(j))) {
      anchor = j;
      other = i;
    }
    const key = `${kind}:${anchor}`;
    if (!grouped.has(key)) grouped.set(key, { kind, anchor, others: [] });
    grouped.get(key).others.push(other);
  }
  return [...grouped.values()].map(({ kind, anchor, others }) => {
    others.sort((x, y) => headRows[x].line - headRows[y].line);
    const row = headRows[anchor];
    const counterpart = headRows[others[0]];
    const more = others.length > 1 ? `, and ${others.length - 1} more` : '';
    const relation = row.line < counterpart.line ? 'before' : 'after';
    const messages = {
      stage: `This stage ${row.stage} row appears ${relation} a stage ${counterpart.stage} row (line ${counterpart.line}${more}); proposals must be sorted by stage, descending.`,
      timebox: `This ${row.cells[1]} row appears ${relation} a ${counterpart.cells[1]} row of the same stage (line ${counterpart.line}${more}); proposals of equal stage must be sorted by timebox, ascending.`,
      insertion: `This newly added row appears before a pre-existing row of the same stage and timebox (line ${counterpart.line}${more}); rows of equal stage and timebox are sorted by insertion date, so new rows go after existing ones.`,
      reorder: `This row appears ${relation} the row on line ${counterpart.line}${more}, but they are in the opposite order on the base branch; rows of equal stage and timebox are sorted by insertion date and must not be reordered.`,
    };
    return { kind, line: row.line, message: messages[kind] };
  });
}

export function checkFile(baseContents, headContents) {
  const headTables = parseProposalsTables(headContents);
  // Every current agenda document has a proposals table (it is in the
  // template), and edits are made to the upcoming meeting's document, so a
  // changed document without one means the table structure drifted and our
  // matching silently broke. Report it rather than passing vacuously.
  if (headTables.length === 0) {
    return [{
      kind: 'missing-table',
      line: null,
      message: 'No proposals table (a "| stage | timebox | topic | presenter |" table) was found, so its ordering could not be checked. If the table was renamed, moved, or its columns changed, update scripts/check-proposals-order.mjs to match.',
    }];
  }
  const baseTables = baseContents == null ? [] : parseProposalsTables(baseContents);
  const annotations = [];
  // pair base and head tables by order of appearance; an unpaired head table
  // (or a file absent from the base) has every row treated as newly added
  headTables.forEach((headTable, tableIndex) => {
    const baseRows = tableIndex < baseTables.length ? baseTables[tableIndex].rows : [];
    const headRows = headTable.rows;
    const headToBase = matchRows(baseRows, headRows);
    const violations = [
      ...findNewStaticViolations(baseRows, headRows, headToBase),
      ...findInsertionViolations(baseRows, headRows, headToBase),
    ];
    annotations.push(...coalesceViolations(violations, baseRows, headRows, headToBase));
  });
  return annotations.sort((a, b) => a.line - b.line);
}

// ---------- CLI ----------

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function tryGitShow(commit, file) {
  try {
    return git('show', `${commit}:${file}`);
  } catch {
    return null;
  }
}

// per https://docs.github.com/en/actions/reference/workflow-commands-for-github-actions
function escapeAnnotationData(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeAnnotationProperty(text) {
  return escapeAnnotationData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

function main() {
  const options = { base: null, head: null, strict: false, files: [] };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--base': options.base = argv[++i]; break;
      case '--head': options.head = argv[++i]; break;
      case '--strict': options.strict = true; break;
      default: options.files.push(argv[i]);
    }
  }
  if (options.base == null) {
    console.error('Usage: check-proposals-order.mjs --base <ref> [--head <ref>] [--strict] [files...]');
    process.exit(2);
  }

  // run from the repo root so annotation paths are repo-relative
  process.chdir(git('rev-parse', '--show-toplevel').trim());

  let base;
  try {
    base = git('rev-parse', '--verify', `${options.base}^{commit}`).trim();
  } catch {
    console.error(`Cannot resolve base ref '${options.base}'.`);
    process.exit(2);
  }
  const head = options.head ?? 'HEAD'; // file contents still come from the working tree when --head is omitted
  // compare against the fork point, so that changes merged to the base branch
  // after this branch diverged are not attributed to it
  try {
    base = git('merge-base', base, head).trim();
  } catch {
    // e.g. shallow history; fall back to the base ref itself
  }

  let files = options.files;
  if (files.length === 0) {
    const diffArgs = ['diff', '--name-only', '--diff-filter=ACMR', '--no-renames', base];
    if (options.head != null) diffArgs.push(options.head);
    files = git(...diffArgs).split('\n').filter(file => AGENDA_PATH_PATTERN.test(file));
  }
  if (files.length === 0) {
    console.error('No agenda documents changed.');
    process.exit(0);
  }

  let errorCount = 0;
  let runFailed = false;
  for (const file of files) {
    const baseContents = tryGitShow(base, file);
    let headContents;
    if (options.head == null) {
      try {
        headContents = fs.readFileSync(file, 'utf8');
      } catch {
        console.error(`Cannot read '${file}' from the working tree.`);
        process.exit(2);
      }
    } else {
      headContents = tryGitShow(options.head, file);
      if (headContents == null) {
        console.error(`Cannot read '${file}' from '${options.head}'.`);
        process.exit(2);
      }
    }
    const annotations = checkFile(baseContents, headContents);
    for (const { kind, line, message } of annotations) {
      if (RUN_FAILURE_KINDS.has(kind)) runFailed = true;
      else if (SEVERITY[kind] === 'error') errorCount++;
      const title = RUN_FAILURE_KINDS.has(kind) ? 'Proposals table not found' : 'Proposals table ordering';
      // a run-failure annotation has no row to anchor to, so it is file-level
      const location = line == null
        ? `file=${escapeAnnotationProperty(file)}`
        : `file=${escapeAnnotationProperty(file)},line=${line}`;
      console.log(`::${SEVERITY[kind]} ${location},title=${title}::${escapeAnnotationData(message)}`);
    }
    if (annotations.length === 0) {
      console.error(`OK: ${file}`);
    } else if (annotations.some(annotation => RUN_FAILURE_KINDS.has(annotation.kind))) {
      console.error(`Could not check ${file}: no proposals table found.`);
    } else {
      console.error(`${annotations.length} ordering problem(s) introduced in ${file}`);
    }
  }
  // a failure to run takes precedence over ordering violations
  if (runFailed) process.exit(2);
  if (options.strict && errorCount > 0) process.exit(1);
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
