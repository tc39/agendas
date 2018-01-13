#!/usr/bin/env node

'use strict';

const glob = require('glob');
const path = require('path');
const magic = require('markdown-magic');
const dedent = require('dedent');

const root = path.join(__dirname, '..');

const agendas = glob.sync(path.join(root, '2*', '*.md'));

const dates = agendas.map(x => (
  path.relative(root, x) // remove root dir name
    .split(path.sep) // split year/month
    .map(y => path.basename(y, path.extname(y))) // strip off .md
));

const byYear = Object.entries(dates.reduce((acc, [y, m]) => ({
  ...acc,
  [y]: (acc[y] || []).concat(m).sort().reverse(),
}), {})).sort(([aY], [bY]) => bY - aY);

const readme = path.join(root, 'README.md');

function isOpen(y) {
  if (y === String(new Date().getFullYear())) {
    return ' open';
  }
  return '';
}

const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

magic(readme, {
  transforms: {
    TC39(content, options) {
      return dedent(byYear.map(([year, months]) => {
        return `<details${isOpen(year)}>
          <summary>${year}</summary>

            ${dedent(months.map(m => `- [${monthNames[m - 1]}](./${year}/${m}.md)`).join('\n'))}
          </details>`;
      }).join('\n\n'));
    },
  },
  matchWord: 'AGENDA_LIST',
});
