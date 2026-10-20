'use strict';
// Every text of Lustre Review that a translation needs: the t() and tn()
// calls of the extension and its page, and the page's own HTML.
const fs = require('node:fs');
const path = require('node:path');
const { pageHtml } = require('../src/view');
const { htmlKeys, fill } = require('../src/l10n');

const ROOT = path.join(__dirname, '..');
const SOURCES = [...fs.readdirSync(path.join(ROOT, 'src')).filter(name => name.endsWith('.js') && name !== 'l10n.js').map(name => path.join('src', name)),
  path.join('media', 'review.js')];
const LITERAL = String.raw`'((?:[^'\\]|\\.)*)'`;
const unquote = text => JSON.parse(`"${text.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`);

// text -> 'text' or 'plural', with the files that use it.
function sourceKeys() {
  const keys = new Map();
  const add = (key, kind, file) => {
    const entry = keys.get(key) || { kind, files: new Set() };
    if (kind === 'plural') entry.kind = 'plural';
    entry.files.add(file); keys.set(key, entry);
  };
  for (const file of SOURCES) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const match of code.matchAll(new RegExp(String.raw`\bt\(` + LITERAL, 'g'))) add(unquote(match[1]), 'text', file);
    // tn(count, 'one', 'other'): the other form is the key, the one form its English singular.
    for (const match of code.matchAll(new RegExp(String.raw`\btn\([^'()]*(?:\([^()]*\)[^'()]*)*,\s*` + LITERAL + String.raw`,\s*` + LITERAL, 'g'))) {
      add(unquote(match[2]), 'plural', file);
    }
  }
  return keys;
}

// The page as the extension writes it, its translated parts marked so that
// only the text written straight into the HTML counts.
function pageKeys() {
  const MARK = '⁣';
  const marked = { language: 'en', locale: 'en-GB', words: {}, t: (text, values) => `${MARK}${fill(text, values)}${MARK}`, tn: () => MARK };
  const webview = { cspSource: 'vscode-resource:', asWebviewUri: uri => uri };
  const vscode = { Uri: { joinPath: (base, ...parts) => [base, ...parts].join('/') } };
  const html = pageHtml(webview, vscode, 'extension', marked, { setting: 'auto', vscode: 'en' });
  return new Set([...htmlKeys(html)].filter(key => !key.includes(MARK)));
}

function allKeys() {
  const keys = sourceKeys();
  for (const key of pageKeys()) if (!keys.has(key)) keys.set(key, { kind: 'text', files: new Set(['src/view.js (HTML)']) });
  return keys;
}

const placeholders = text => [...new Set(String(text).match(/\{\w+\}/g) || [])].sort();

module.exports = { sourceKeys, pageKeys, allKeys, placeholders };

if (require.main === module) {
  const keys = allKeys();
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(Object.fromEntries([...keys].map(([key, entry]) => [key, entry.kind])), null, 1));
  } else for (const [key, entry] of keys) console.log(`${entry.kind === 'plural' ? 'P' : 'T'}\t${key}`);
}
