#!/usr/bin/env node

// Entry point for the check-proposals-order npm script. Runs the checker over
// the agenda documents changed between a base commit and the working tree (or
// a given head), reporting problems as GitHub workflow-command annotations
// (::error / ::warning) that render inline on the PR diff. The checking logic
// lives in check-proposals-order.mjs.
//
// Usage: npm run check-proposals-order -- --base <ref> [--head <ref>] [--strict] [files...]
//   --base    base branch commit; the comparison point is `git merge-base
//             <base> <head>`, i.e. the fork point
//   --head    commit whose file contents to check; defaults to the working tree
//   --strict  exit 1 if any error-severity ordering problem is found
//   files     repo-relative agenda paths; defaults to the agenda documents
//             changed between base and head
//
// Example: npm run check-proposals-order -- --base origin/main
//
// Exit codes:
//   0  ran cleanly, or found only advisory ordering problems
//   1  found error-severity ordering problems and --strict was passed
//   2  could not run: bad usage, an unresolvable ref, an unreadable file, or
//      a changed agenda document with no proposals table to check
// Ordering problems do not fail the check by default so that we can gain
// confidence in the absence of false positives before passing --strict to
// block merging. A missing proposals table is not an ordering problem but a
// failure to run — the table was renamed, moved, or its structure drifted
// enough to break matching — so it always exits non-zero, --strict or not.

import { execFileSync } from 'child_process';
import fs from 'fs';

import { checkFile } from './check-proposals-order.mjs';

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
  console.error('Usage: npm run check-proposals-order -- --base <ref> [--head <ref>] [--strict] [files...]');
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
