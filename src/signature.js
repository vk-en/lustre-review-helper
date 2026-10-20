'use strict';

function reviewSignature(name, run, includeDetails = false) {
  return `[${name || 'AI review'}${includeDetails === true ? ` - ${run.modelName || run.model || 'AI'} - ${run.effort || 'Default'}` : ''}]`;
}

// The signature is plain text, escaped so the brackets never become a link.
// A report signed in bold by an earlier version is converted when reopened.
function signedReport(markdown, signature) {
  const line = signature.replace(/[\\`*_{}\[\]<>]/g, '\\$&');
  const bold = `**${line}**`;
  const found = /^## Overall assessment[^\S\r\n]*\r?$/m.exec(markdown);
  if (!found) {
    const section = `## Overall assessment\n\n${line}\n\n`;
    const findings = /^## Findings[^\S\r\n]*\r?$/m.exec(markdown);
    return findings ? markdown.slice(0, findings.index) + section + markdown.slice(findings.index) : `${markdown.trimEnd()}\n\n${section}`;
  }
  const end = found.index + found[0].length, rest = markdown.slice(end), body = rest.trimStart();
  const gap = rest.slice(0, rest.length - body.length);
  if (body.startsWith(bold)) return markdown.slice(0, end) + gap + line + body.slice(bold.length);
  if (body.startsWith(line)) return markdown;
  return `${markdown.slice(0, end)}\n\n${line}${rest}`;
}

module.exports = { reviewSignature, signedReport };
