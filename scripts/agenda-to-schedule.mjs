#!/usr/bin/env node

// ye olde rudimentary script to convert agenda-formatted topics to schedule-formatted topics
// example: node agenda-to-schedule.mjs "../2024/04.md"

import { marked } from 'marked';
import fs from 'fs';
import { argv } from 'process';

const tokenTypeEnum = Object.freeze({
  LIST: 'list',
  LIST_ITEM: 'list_item',
  PARAGRAPH: 'paragraph',
  SPACE: 'space',
  TABLE: 'table',
  TEXT: 'text',
});

const reTimebox = /(\dh)?\d+m/;
const agendaFile = argv[2];
const contents = fs.readFileSync(agendaFile, 'utf8').toString();
const rootTokens = marked.lexer(contents, { ...marked.getDefaults(), });

// 1 tokens can be lists, text, html, etc.
// 2 a list has an items array containing tokens of type list_item
// 3   list_items have tokens
// 4   GOTO 1
// 5 a table has a rows array (columns)
// 6   a column is an array containing tokens
// 7   GOTO 1

rootTokens.forEach(processToken);

function processToken(t) {

  switch (t.type) {
    case tokenTypeEnum.LIST:
      t.items.forEach(processToken);
      break;
    case tokenTypeEnum.LIST_ITEM:
      t.tokens.forEach(processToken);
      break;
    case tokenTypeEnum.TABLE:
      t.rows.forEach(processRow);
      break;
    case tokenTypeEnum.TEXT:
      if (reTimebox.test(t.text)){
        // 🐽 smells like a topic
        console.log(`- ${t.text}`);
      }
      break;
    default:
      // ignore
      break;
  }

}

function processRow(r){
  for (let i = 0; i < r.length; i++) {

    const timebox = r[i].text;

    // find the timebox column
    if (reTimebox.test(timebox)){
      const topic = r[i + 1].text;
      const presenter = r[i + 2].text;
      console.log(`- ${topic} (${timebox}, ${presenter})`);
    }
  }
}
