'use strict';

const { git } = require('./git');
const { t } = require('./l10n');
const HOST = 'review.whamcloud.com';

function remoteProject(value) {
  if (typeof value !== 'string' || /[\x00-\x20\x7f\\]/.test(value)) return undefined;
  let host, pathname;
  if (value.includes('://')) {
    try {
      const url = new URL(value);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || url.search || url.hash) return undefined;
      host = url.hostname; pathname = url.pathname;
    } catch { return undefined; }
  } else {
    const match = value.match(/^(?:[^@/:]+@)?([^/:]+):(.+)$/);
    if (!match) return undefined;
    [, host, pathname] = match;
  }
  if (host.toLowerCase() !== HOST) return undefined;
  try { pathname = decodeURIComponent(pathname); } catch { return undefined; }
  const project = pathname.replace(/^\/+/, '').replace(/^a\//, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(project) || project.split('/').some(p => p === '.' || p === '..')) return undefined;
  return project;
}

async function repositoryProject(repo) {
  if (!repo) throw new Error(t('Choose a local Git repository in Local commits before adding Gerrit patches.'));
  let remotes;
  try {
    const names = (await git(repo, ['remote'])).trim().split('\n').filter(Boolean);
    remotes = await Promise.all(names.map(async name => {
      // get-url expands Git's insteadOf aliases. Inspect both directions, but
      // never return credential-bearing URLs to the UI or error log.
      const urls = await Promise.all([false, true].map(push => git(repo, ['remote', 'get-url', '--all', ...(push ? ['--push'] : []), name])));
      return { name, projects: [...new Set(urls.flatMap(text => text.trim().split('\n').map(remoteProject).filter(Boolean)))] };
    }));
  } catch { throw new Error(t('Could not read this repository’s Git remotes. Check the repository selected in Local commits.')); }
  const choose = projects => {
    if (projects.length === 1) return projects[0];
    throw new Error(t('This repository has conflicting Gerrit projects ({projects}). Set origin to the project you want to review.', { projects: projects.join(', ') }));
  };
  const origin = remotes.find(remote => remote.name === 'origin');
  if (origin?.projects.length) return choose(origin.projects);
  let tracking;
  try {
    const branch = (await git(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim();
    tracking = (await git(repo, ['config', '--get', `branch.${branch}.remote`])).trim();
  } catch { /* Detached HEAD or an untracked branch: require one unique project. */ }
  const upstream = remotes.find(remote => remote.name === tracking);
  if (upstream?.projects.length) return choose(upstream.projects);
  const projects = [...new Set(remotes.flatMap(remote => remote.projects))];
  if (projects.length) return choose(projects);
  throw new Error(t('Cannot identify this repository’s Gerrit project. Configure a Git remote pointing to {host}/<project>, then add the patch again.', { host: HOST }));
}

async function verifyPatchProjects(repo, patches) {
  const project = await repositoryProject(repo);
  for (const patch of patches) {
    if (typeof patch.project !== 'string' || !/^[\w.-]+(?:\/[\w.-]+)*$/.test(patch.project)) {
      throw new Error(t('Gerrit did not return a valid project for change #{number}. The patch was not accepted.', { number: patch.number }));
    }
    if (patch.project !== project) throw new Error(t('Change #{number} belongs to "{project}", but the current repository is "{current}". Open the matching repository to review this patch.', { number: patch.number, project: patch.project, current: project }));
  }
  return project;
}

module.exports = { remoteProject, repositoryProject, verifyPatchProjects };
