'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LANGUAGES, resolveLanguage, translator, localizeHtml, dictionary } = require('../src/l10n');
const { reviewHtml } = require('../src/view');
const { allKeys, placeholders } = require('./l10n-keys');

const ROOT = path.join(__dirname, '..');
const OTHERS = LANGUAGES.map(language => language.id).filter(id => id !== 'en');

test('the language follows the setting, else VS Code, else English', () => {
  assert.equal(resolveLanguage('de', 'ru'), 'de');
  assert.equal(resolveLanguage('auto', 'ru'), 'ru');
  assert.equal(resolveLanguage(undefined, 'es-mx'), 'es');
  assert.equal(resolveLanguage('auto', 'zh-tw'), 'zh-cn', 'any Chinese gets Simplified Chinese');
  assert.equal(resolveLanguage('auto', 'pt-br'), 'en');
  assert.equal(resolveLanguage('xx', undefined), 'en');
});

test('a translation fills placeholders and chooses the plural form of its language', () => {
  const words = { 'Commit {sha}': 'Коммит {sha}', '{n} commits': { one: '{n} коммит', few: '{n} коммита', many: '{n} коммитов', other: '{n} коммита' } };
  const { t, tn } = translator('ru', words);
  assert.equal(t('Commit {sha}', { sha: 'abc' }), 'Коммит abc');
  assert.equal(t('Not translated {x}', { x: 1 }), 'Not translated 1');
  assert.deepEqual([1, 3, 5, 21, 112].map(n => tn(n, '{n} commit', '{n} commits')), ['1 коммит', '3 коммита', '5 коммитов', '21 коммит', '112 коммитов']);
  const english = translator('en', {});
  assert.deepEqual([1, 2].map(n => english.tn(n, '{n} commit', '{n} commits')), ['1 commit', '2 commits']);
});

test('the page translates its text and labels, never its scripts or names marked translate="no"', () => {
  // Joining punctuation before a text is kept apart; the text keeps its own end.
  const t = text => ({ Hello: 'Привет', 'Open it': 'Открыть', English: 'Английский', 'R & D.': 'НИОКР.' })[text] || text;
  const html = '<p title="Open it">Hello</p><b>, R &amp; D.</b><span translate="no">English</span><script>"Hello"</script>';
  assert.equal(localizeHtml(html, t), '<p title="Открыть">Привет</p><b>, НИОКР.</b><span translate="no">English</span><script>"Hello"</script>');
});

test('every language has every text of the extension, with the same placeholders', () => {
  const keys = allKeys();
  assert.ok(keys.size > 600, `only ${keys.size} texts found`);
  for (const language of OTHERS) {
    const words = JSON.parse(fs.readFileSync(path.join(ROOT, 'l10n', `${language}.json`), 'utf8'));
    const missing = [...keys.keys()].filter(key => !Object.hasOwn(words, key));
    assert.deepEqual(missing, [], `${language} lacks translations`);
    const unused = Object.keys(words).filter(key => !keys.has(key));
    assert.deepEqual(unused, [], `${language} has translations nothing uses`);
    // Every form the language uses, except Spanish "many", which only
    // millions take and which falls back to "other".
    const forms = new Intl.PluralRules(LANGUAGES.find(entry => entry.id === language).locale).resolvedOptions().pluralCategories
      .filter(form => !(language === 'es' && form === 'many'));
    for (const [key, { kind }] of keys) {
      const value = words[key];
      if (kind === 'plural') {
        assert.equal(typeof value, 'object', `${language}: "${key}" needs plural forms`);
        for (const form of forms) {
          assert.equal(typeof value[form], 'string', `${language}: "${key}" lacks its ${form} form`);
        }
        for (const text of Object.values(value)) assert.ok(placeholders(text).every(name => placeholders(key).includes(name)), `${language}: ${text}`);
        assert.deepEqual(placeholders(value.other), placeholders(key), `${language}: ${value.other}`);
      } else {
        assert.equal(typeof value, 'string', `${language}: "${key}" is a plain text`);
        assert.deepEqual(placeholders(value), placeholders(key), `${language}: ${value}`);
      }
    }
  }
});

test('the page in Russian, with its dictionary for the script', () => {
  const webview = { cspSource: 'vscode-resource:', asWebviewUri: uri => uri };
  const vscode = { Uri: { joinPath: (base, ...parts) => [base, ...parts].join('/') } };
  const html = reviewHtml(webview, vscode, 'extension', translator('ru'), { setting: 'ru', vscode: 'en' });
  assert.match(html, /<html lang="ru">/);
  assert.match(html, />Локальные коммиты</);
  assert.match(html, /title="Язык: язык Lustre Review Helper\."/);
  assert.match(html, /<span class="language-name" translate="no">English<\/span><span class="language-note">английский<\/span>/);
  assert.match(html, /<span class="language-name" translate="no">Русский<\/span><svg/, 'no note that repeats the name');
  assert.match(html, /role="option" aria-selected="true" data-language="ru"/);
  const data = JSON.parse(/<script type="application\/json" id="l10nData">([^<]*)<\/script>/.exec(html)[1]);
  assert.equal(data.locale, 'ru-RU');
  assert.equal(data.words['Reports & History'], 'Отчёты и история');
  assert.doesNotMatch(html, />Local commits</);
});

test('settings and commands are named in every language', () => {
  const manifest = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.nls.json'), 'utf8'));
  for (const [, key] of manifest.matchAll(/"%([\w.]+)%"/g)) assert.ok(Object.hasOwn(base, key), `package.nls.json lacks ${key}`);
  for (const language of OTHERS) {
    const words = JSON.parse(fs.readFileSync(path.join(ROOT, `package.nls.${language}.json`), 'utf8'));
    assert.deepEqual(Object.keys(words).sort(), Object.keys(base).sort(), `package.nls.${language}.json`);
    assert.ok(Object.values(words).every(value => typeof value === 'string' && value.trim()), language);
  }
  assert.deepEqual(JSON.parse(manifest).contributes.configuration.properties['lustreReview.language'].enum, ['auto', ...LANGUAGES.map(entry => entry.id)]);
  assert.deepEqual(dictionary('en'), {});
});
