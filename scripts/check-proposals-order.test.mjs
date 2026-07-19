import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  checkFile,
  findInsertionViolations,
  findNewStaticViolations,
  findStaticViolations,
  matchRows,
  parseProposalsTables,
  parseStage,
  parseTimebox,
  splitCells,
} from './check-proposals-order.mjs';

// wraps proposal rows in a minimal agenda document, indented inside a list
// item like the real thing
function agenda(...rows) {
  return [
    '## Agenda items',
    '',
    '1. Short (≤30m) Timeboxed Discussions',
    '',
    '    | timebox | topic | presenter |',
    '    |:-------:|-------|-----------|',
    '    | 30m | a sibling table row that must be ignored | Alice |',
    '',
    '1. Proposals',
    '',
    '    | stage | timebox | topic | presenter |',
    '    |:-----:|:-------:|-------|-----------|',
    ...rows.map(row => `    ${row}`),
    '',
    '1. Other business',
    '',
  ].join('\n');
}

// an agenda document whose proposals table our matcher would not find, e.g.
// because its structure drifted (here, the header columns were renamed)
function agendaWithoutProposals() {
  return [
    '## Agenda items',
    '',
    '1. Proposals',
    '',
    '    | stage | duration | topic | presenter |',
    '    |:-----:|:--------:|-------|-----------|',
    '    | 1 | 30m | [A](https://example.com/a) | Alice |',
    '',
  ].join('\n');
}

function proposalRows(contents) {
  const tables = parseProposalsTables(contents);
  assert.equal(tables.length, 1);
  return tables[0].rows;
}

test('parseStage', () => {
  assert.equal(parseStage('3'), 3);
  assert.equal(parseStage('2.7'), 2.7);
  assert.equal(parseStage('0'), 0);
  assert.equal(parseStage('-'), null);
  assert.equal(parseStage('N/A'), null);
  assert.equal(parseStage('0 / 2'), null);
  assert.equal(parseStage(''), null);
});

test('parseTimebox', () => {
  assert.equal(parseTimebox('30m'), 30);
  assert.equal(parseTimebox('5m'), 5);
  assert.equal(parseTimebox('1h'), 60);
  assert.equal(parseTimebox('1h30m'), 90);
  assert.equal(parseTimebox('10-30m'), null);
  assert.equal(parseTimebox('30'), null);
  assert.equal(parseTimebox(''), null);
});

test('splitCells', () => {
  assert.deepEqual(splitCells('| 1 | 30m | topic | presenter |'), ['1', '30m', 'topic', 'presenter']);
  // GFM permits omitting the trailing pipe
  assert.deepEqual(splitCells('| 1 | 30m | topic | presenter'), ['1', '30m', 'topic', 'presenter']);
  // escaped pipes do not split cells
  assert.deepEqual(splitCells('| 1 | 30m | a \\| b | presenter |'), ['1', '30m', 'a \\| b', 'presenter']);
  // a stray unescaped pipe adds a cell but leaves the leading key cells alone
  assert.deepEqual(splitCells('| 1 | 30m | a | b | presenter |'), ['1', '30m', 'a', 'b', 'presenter']);
});

test('parseProposalsTables finds only the 4-column proposals table', () => {
  const contents = agenda(
    '| 3 | 30m | [A](https://example.com/a) | Alice |',
    '| 2 | 15m | [B](https://example.com/b) | Bob |',
  );
  const rows = proposalRows(contents);
  assert.deepEqual(
    rows.map(({ line, stage, timebox, url }) => ({ line, stage, timebox, url })),
    [
      { line: 13, stage: 3, timebox: 30, url: 'https://example.com/a' },
      { line: 14, stage: 2, timebox: 15, url: 'https://example.com/b' },
    ],
  );
});

test('parseProposalsTables skips the legacy 5-column header', () => {
  const contents = [
    '    | ✓ | stage | timebox | topic | presenter |',
    '    |:-:|:-----:|:-------:|-------|-----------|',
    '    |   | 3 | 30m | A | Alice |',
  ].join('\n');
  assert.deepEqual(parseProposalsTables(contents), []);
});

test('parseProposalsTables handles an empty table fresh from the template', () => {
  assert.deepEqual(proposalRows(agenda()), []);
});

test('static check accepts a correctly sorted table', () => {
  const rows = proposalRows(agenda(
    '| 3 | 30m | A | Alice |',
    '| 2.7 | 30m | B | Bob |',
    '| 2 | 30m | C | Carol |',
    '| 2 | 45m | D | Dan |',
    '| 1 | 20m | E | Erin |',
    '| 0 | 60m | F | Frank |',
  ));
  assert.deepEqual(findStaticViolations(rows), []);
});

test('static check finds stage and timebox violations', () => {
  const rows = proposalRows(agenda(
    '| 2 | 30m | A | Alice |',
    '| 3 | 30m | B | Bob |',
    '| 2 | 15m | C | Carol |',
  ));
  assert.deepEqual(findStaticViolations(rows), [
    { kind: 'stage', i: 0, j: 1 },
    { kind: 'timebox', i: 0, j: 2 },
  ]);
});

test('a row with unparseable keys does not mask violations across it', () => {
  const rows = proposalRows(agenda(
    '| 1 | 30m | A | Alice |',
    '| N/A | 30m | B | Bob |',
    '| 1 | 20m | C | Carol |',
  ));
  assert.deepEqual(findStaticViolations(rows), [{ kind: 'timebox', i: 0, j: 2 }]);
});

test('rows are matched by exact text, then by first topic link URL', () => {
  const baseRows = proposalRows(agenda(
    '| 2 | 30m | [A](https://example.com/a) | Alice |',
    '| 1 | 30m | [B](https://example.com/b) | Bob |',
  ));
  const headRows = proposalRows(agenda(
    '| 2 | 30m | [A](https://example.com/a) | Alice |',
    '| 1 | 30m | [B](https://example.com/b) update ([slides](https://example.com/slides)) | Bob |',
    '| 0 | 30m | [C](https://example.com/c) | Carol |',
  ));
  assert.deepEqual(matchRows(baseRows, headRows), [0, 1, null]);
});

test('duplicate-URL rows match deterministically, exact text first', () => {
  const baseRows = proposalRows(agenda(
    '| 2 | 30m | [A](https://example.com/a) part one | Alice |',
    '| 2 | 45m | [A](https://example.com/a) part two | Alice |',
  ));
  const headRows = proposalRows(agenda(
    '| 2 | 30m | [A](https://example.com/a) part one, edited | Alice |',
    '| 2 | 45m | [A](https://example.com/a) part two | Alice |',
  ));
  // the exact-text pass claims row 1 for "part two"; the URL fallback then
  // pairs the edited "part one" with the remaining base row
  assert.deepEqual(matchRows(baseRows, headRows), [0, 1]);
});

test('pre-existing violations are suppressed, even when only the topic was edited', () => {
  const base = agenda(
    '| 2 | 60m | [A](https://example.com/a) | Alice |',
    '| 2 | 30m | [B](https://example.com/b) | Bob |',
  );
  const untouched = checkFile(base, agenda(
    '| 2 | 60m | [A](https://example.com/a) | Alice |',
    '| 2 | 30m | [B](https://example.com/b) | Bob |',
    '| 1 | 30m | [C](https://example.com/c) | Carol |',
  ));
  assert.deepEqual(untouched, []);
  const topicEdited = checkFile(base, agenda(
    '| 2 | 60m | [A](https://example.com/a) ([slides](https://example.com/slides)) | Alice |',
    '| 2 | 30m | [B](https://example.com/b) | Bob |',
  ));
  assert.deepEqual(topicEdited, []);
});

test('editing a timebox into violation is attributed to the change', () => {
  const base = agenda(
    '| 2 | 30m | [A](https://example.com/a) | Alice |',
    '| 2 | 45m | [B](https://example.com/b) | Bob |',
  );
  const head = agenda(
    '| 2 | 60m | [A](https://example.com/a) | Alice |',
    '| 2 | 45m | [B](https://example.com/b) | Bob |',
  );
  const annotations = checkFile(base, head);
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].kind, 'timebox');
  assert.equal(annotations[0].line, 13);
});

test('a new row inserted above rows of the same stage with smaller timeboxes fails', () => {
  // the shape of tc39/agendas#2125: a (1, 60m) row added at the top of the
  // stage-1 block
  const base = agenda(
    '| 1 | 20m | [A](https://example.com/a) | Alice |',
    '| 1 | 20m | [B](https://example.com/b) | Bob |',
    '| 1 | 30m | [C](https://example.com/c) | Carol |',
    '| 1 | 30m | [D](https://example.com/d) | Dan |',
  );
  const head = agenda(
    '| 1 | 60m | [E](https://example.com/e) | Erin |',
    '| 1 | 20m | [A](https://example.com/a) | Alice |',
    '| 1 | 20m | [B](https://example.com/b) | Bob |',
    '| 1 | 30m | [C](https://example.com/c) | Carol |',
    '| 1 | 30m | [D](https://example.com/d) | Dan |',
  );
  const annotations = checkFile(base, head);
  // four violating pairs coalesce into a single annotation on the new row
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].kind, 'timebox');
  assert.equal(annotations[0].line, 13);
  assert.match(annotations[0].message, /and 3 more/);
  // and placing it at the end of the stage-1 block instead is clean
  const fixed = agenda(
    '| 1 | 20m | [A](https://example.com/a) | Alice |',
    '| 1 | 20m | [B](https://example.com/b) | Bob |',
    '| 1 | 30m | [C](https://example.com/c) | Carol |',
    '| 1 | 30m | [D](https://example.com/d) | Dan |',
    '| 1 | 60m | [E](https://example.com/e) | Erin |',
  );
  assert.deepEqual(checkFile(base, fixed), []);
});

test('a new row must come after existing rows of the same stage and timebox', () => {
  const base = agenda(
    '| 1 | 30m | [A](https://example.com/a) | Alice |',
    '| 1 | 30m | [B](https://example.com/b) | Bob |',
  );
  const inserted = checkFile(base, agenda(
    '| 1 | 30m | [A](https://example.com/a) | Alice |',
    '| 1 | 30m | [C](https://example.com/c) | Carol |',
    '| 1 | 30m | [B](https://example.com/b) | Bob |',
  ));
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].kind, 'insertion');
  assert.equal(inserted[0].line, 14);
  const appended = checkFile(base, agenda(
    '| 1 | 30m | [A](https://example.com/a) | Alice |',
    '| 1 | 30m | [B](https://example.com/b) | Bob |',
    '| 1 | 30m | [C](https://example.com/c) | Carol |',
  ));
  assert.deepEqual(appended, []);
});

test('reordering existing rows of the same stage and timebox fails', () => {
  const base = agenda(
    '| 1 | 30m | [A](https://example.com/a) | Alice |',
    '| 1 | 30m | [B](https://example.com/b) | Bob |',
  );
  const swapped = checkFile(base, agenda(
    '| 1 | 30m | [B](https://example.com/b) | Bob |',
    '| 1 | 30m | [A](https://example.com/a) | Alice |',
  ));
  assert.equal(swapped.length, 1);
  assert.equal(swapped[0].kind, 'reorder');
});

test('a row whose timebox changed is exempt from intra-group position checks', () => {
  const base = agenda(
    '| 1 | 30m | [A](https://example.com/a) | Alice |',
    '| 1 | 60m | [B](https://example.com/b) | Bob |',
  );
  // B's timebox shrinks to 30m and it lands before A; its insertion date
  // relative to A is unknowable, so only static ordering applies
  const regrouped = checkFile(base, agenda(
    '| 1 | 30m | [B](https://example.com/b) | Bob |',
    '| 1 | 30m | [A](https://example.com/a) | Alice |',
  ));
  assert.deepEqual(regrouped, []);
});

test('a brand-new agenda document gets the static checks only', () => {
  const misordered = checkFile(null, agenda(
    '| 1 | 30m | [A](https://example.com/a) | Alice |',
    '| 2 | 30m | [B](https://example.com/b) | Bob |',
  ));
  assert.equal(misordered.length, 1);
  assert.equal(misordered[0].kind, 'stage');
  const clean = checkFile(null, agenda(
    '| 2 | 30m | [B](https://example.com/b) | Bob |',
    '| 1 | 30m | [A](https://example.com/a) | Alice |',
    '| 1 | 30m | [C](https://example.com/c) | Carol |',
  ));
  assert.deepEqual(clean, []);
});

test('a changed document with no findable proposals table reports a run failure', () => {
  const annotations = checkFile(agenda('| 1 | 30m | [A](https://example.com/a) | Alice |'), agendaWithoutProposals());
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].kind, 'missing-table');
  assert.equal(annotations[0].line, null);
});

test('a brand-new document with no findable proposals table reports a run failure', () => {
  const annotations = checkFile(null, agendaWithoutProposals());
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].kind, 'missing-table');
});

test('an empty table fresh from the template is found, not a run failure', () => {
  assert.deepEqual(checkFile(null, agenda()), []);
});

test('insertion violations report the new row, not the existing one', () => {
  const baseRows = proposalRows(agenda(
    '| 1 | 30m | [A](https://example.com/a) | Alice |',
  ));
  const headRows = proposalRows(agenda(
    '| 1 | 30m | [B](https://example.com/b) | Bob |',
    '| 1 | 30m | [A](https://example.com/a) | Alice |',
  ));
  const headToBase = matchRows(baseRows, headRows);
  assert.deepEqual(findInsertionViolations(baseRows, headRows, headToBase), [
    { kind: 'insertion', i: 0, j: 1 },
  ]);
  assert.deepEqual(findNewStaticViolations(baseRows, headRows, headToBase), []);
});
