'use strict';

const fs = require('node:fs');
const path = require('node:path');

// The languages of Lustre Review. English is the source: its text is the key
// of every translation, and what shows when a translation is missing.
const LANGUAGES = [
  { id: 'en', name: 'English', locale: 'en-GB' },
  { id: 'de', name: 'Deutsch', locale: 'de-DE' },
  { id: 'es', name: 'Español', locale: 'es-ES' },
  { id: 'ja', name: '日本語', locale: 'ja-JP' },
  { id: 'zh-cn', name: '简体中文', locale: 'zh-CN' },
  { id: 'ru', name: 'Русский', locale: 'ru-RU' },
];
const IDS = LANGUAGES.map(language => language.id);

// The setting is a language or "auto": the language of VS Code when it is
// one of ours, Simplified Chinese for any Chinese, else English.
function resolveLanguage(setting, vscodeLanguage) {
  if (IDS.includes(setting)) return setting;
  const code = String(vscodeLanguage || 'en').toLowerCase();
  if (code.startsWith('zh')) return 'zh-cn';
  const base = code.split('-')[0];
  return IDS.includes(base) ? base : 'en';
}

const dictionaries = new Map();
function dictionary(language, directory = path.join(__dirname, '..', 'l10n')) {
  if (language === 'en') return {};
  if (!dictionaries.has(language)) {
    try { dictionaries.set(language, JSON.parse(fs.readFileSync(path.join(directory, `${language}.json`), 'utf8'))); }
    catch { dictionaries.set(language, {}); }
  }
  return dictionaries.get(language);
}

// {name} placeholders take values; a missing value leaves the placeholder.
const fill = (text, values = {}) => String(text).replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);

// A translator for one language. t(text, values) translates; tn(count, one,
// other, values) chooses the plural form the language needs: a translation of
// a plural is an object of Intl plural categories (one, few, many, other).
function translator(language, words = dictionary(language)) {
  const locale = LANGUAGES.find(entry => entry.id === language)?.locale || 'en-GB';
  const rules = new Intl.PluralRules(locale);
  const t = (text, values) => fill(typeof words[text] === 'string' && words[text] ? words[text] : text, values);
  const tn = (count, one, other, values = {}) => {
    const all = { n: count, ...values }, entry = words[other];
    if (entry && typeof entry === 'object') {
      const form = entry[rules.select(count)] || entry.other;
      if (form) return fill(form, all);
    }
    return fill(count === 1 ? one : other, all);
  };
  return { language, locale, t, tn, words };
}

// Names and codes that read the same in every language are not keys.
const NAMES = new Set(['Codex', 'Claude Code', 'Auggie', 'Augment', 'Augment (Auggie)', 'git', 'lreview', 'gerrit-cli', 'gerrit-dashboard',
  'MCP', 'Gerrit', 'Lustre Review', 'Lustre Review Helper', 'GitHub']);
// The part of a piece of text that is a key: without the punctuation that
// joins it to its neighbours, e.g. ". Finds a review" between two quotes.
function keyOf(text) {
  const match = /^([\s.,:;·—–-]*)([\s\S]*?)(\s*)$/.exec(text);
  const key = match[2];
  if (!key || !/[A-Za-z]/.test(key) || NAMES.has(key) || /^https?:\/\//.test(key)) return undefined;
  return { before: match[1], key, after: match[3] };
}

// The text and readable attributes of finished HTML: each text node and
// title, aria-label, placeholder, alt or data-tip. Scripts and styles are left alone.
const decode = text => text.replace(/&(amp|lt|gt|quot|#39);/g, (match, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name]);
const encode = (text, attribute) => text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]).replace(/"/g, attribute ? '&quot;' : '"');
function mapHtml(html, change) {
  return html.split(/(<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>)/).map((part, index) => index % 2 ? part : part
    // The text right inside a tag; not where the tag says translate="no".
    .replace(/(<[^<>]*>)([^<>]+)(?=<)/g, (match, tag, text) => {
      const found = !/\btranslate="no"/.test(tag) && keyOf(decode(text));
      if (!found) return match;
      const next = change(found.key);
      return next === found.key ? match : `${tag}${encode(found.before + next + found.after)}`;
    })
    .replace(/\b(title|aria-label|placeholder|alt|data-tip)="([^"]*)"/g, (match, name, value) => {
      const found = keyOf(decode(value));
      if (!found) return match;
      const next = change(found.key);
      return next === found.key ? match : `${name}="${encode(found.before + next + found.after, true)}"`;
    })).join('');
}
const localizeHtml = (html, t) => mapHtml(html, key => t(key));
function htmlKeys(html) {
  const keys = new Set();
  mapHtml(html, key => { keys.add(key); return key; });
  return keys;
}

// The language the extension speaks now, for modules that build messages.
let current = translator('en', {});
function use(language) { current = translator(language); return current; }
const t = (text, values) => current.t(text, values);
const tn = (count, one, other, values) => current.tn(count, one, other, values);

module.exports = { LANGUAGES, resolveLanguage, translator, dictionary, localizeHtml, htmlKeys, keyOf, fill, use, t, tn,
  language: () => current.language, locale: () => current.locale };
