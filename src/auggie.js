'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { t } = require('./l10n');

async function listModels(binary) {
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)(binary, ['models', 'list', '--json'], {
      timeout: 25000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, AUGMENT_DISABLE_AUTO_UPDATE: '1' },
    }));
  } catch (error) {
    const message = String(error.stderr || error.stdout || error.message).trim().slice(-1500);
    throw new Error(`${t('Cannot load Augment models. Use “Auggie login” in AI settings.')} ${message}`);
  }
  let catalog;
  try { catalog = JSON.parse(stdout); } catch { throw new Error(t('Auggie returned an invalid model catalog. Update Auggie CLI.')); }
  if (!Array.isArray(catalog.models)) throw new Error(t('Auggie returned no model catalog. Update Auggie CLI.'));
  const models = catalog.models.filter(m => typeof m.id === 'string' && m.id && !m.disabled).map(m => ({
    id: m.id, name: m.displayName || m.id, description: m.description || '',
    isDefault: m.id === catalog.defaultModelId || !!m.isDefault,
    efforts: Array.isArray(m.effortLevels) ? m.effortLevels.map(e => typeof e === 'string' ? e : e.value).filter(e => typeof e === 'string') : [],
  }));
  if (!models.length && typeof catalog.defaultModelId === 'string' && catalog.defaultModelId) {
    models.push({id:catalog.defaultModelId, name:'Account default', description:'Default model reported by Auggie', isDefault:true, efforts:[]});
  }
  if (!models.length) throw new Error(t('Auggie returned no available models. Check your Augment account.'));
  return models;
}
module.exports = { listModels };
