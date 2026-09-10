#!/usr/bin/env node
/**
 * embed-tokens.cjs
 * Reads design-tokens.css and outputs embeddable inline CSS.
 * Use when generating standalone HTML files (infographics, slides, etc.)
 *
 * Usage:
 *   node embed-tokens.cjs           # Output full CSS
 *   node embed-tokens.cjs --minimal # Output only commonly used tokens
 *   node embed-tokens.cjs --style   # Wrap in <style> tags
 */

const fs = require('fs');
const path = require('path');

// Find project root (look for assets/design-tokens.css)
function findProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  const { root } = path.parse(dir);
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, 'assets', 'design-tokens.css'))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return null;
}

// Search from cwd first; when invoked by absolute path from outside the
// project tree, fall back to the script's own location.
const projectRoot = findProjectRoot(process.cwd()) || findProjectRoot(__dirname);
if (!projectRoot) {
  console.error('Error: Could not find assets/design-tokens.css (searched from cwd and script directory)');
  process.exit(1);
}

const tokensPath = path.join(projectRoot, 'assets', 'design-tokens.css');

// Minimal tokens commonly used in infographics/slides
const MINIMAL_TOKENS = [
  '--primitive-spacing-',
  '--primitive-fontSize-',
  '--primitive-fontWeight-',
  '--primitive-lineHeight-',
  '--primitive-radius-',
  '--primitive-shadow-glow-',
  '--primitive-gradient-',
  '--primitive-duration-',
  '--color-primary',
  '--color-secondary',
  '--color-accent',
  '--color-background',
  '--color-surface',
  '--color-foreground',
  '--color-border',
  '--typography-font-',
  '--card-',
];

// A closing quote only ends the string when preceded by an even number of
// backslashes ('\\"' is an escaped backslash + a real closing quote).
function closesQuote(text, i) {
  let backslashes = 0;
  for (let j = i - 1; text[j] === '\\'; j--) backslashes++;
  return backslashes % 2 === 0;
}

// Split on a separator, ignoring separators inside quotes or parentheses
// (e.g. data URIs like url("data:image/svg+xml;utf8,..."))
function splitTopLevel(text, separator) {
  const parts = [];
  let current = '';
  let quote = null;
  let depth = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote && closesQuote(text, i)) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
    } else if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function extractTokens(css, minimal = false) {
  // Quote-aware block extraction: `[^}]+` would truncate at a '}' inside a
  // quoted value (e.g. url("data:image/svg+xml,<svg>…</svg>")).
  const bodies = [];
  const re = /:root\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1;
    let quote = null;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < css.length && depth > 0; i++) {
      const ch = css[i];
      if (quote) {
        if (ch === quote && closesQuote(css, i)) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
      }
    }
    bodies.push(css.slice(start, i - 1));
  }
  if (bodies.length === 0) {
    throw new Error(`No :root block found in ${tokensPath}`);
  }

  let allVars = [];
  for (const body of bodies) {
    // Strip comments first so a ';' inside /* ... */ cannot split mid-comment
    const vars = splitTopLevel(body.replace(/\/\*[\s\S]*?\*\//g, ''), ';')
      .map(d => d.trim())
      .filter(d => /^--[\w-]+\s*:/.test(d))
      .map(d => (d.endsWith(';') ? d : d + ';'));
    allVars = allVars.concat(vars);
  }

  if (minimal) {
    allVars = allVars.filter(v => {
      const name = v.slice(0, v.indexOf(':'));
      return MINIMAL_TOKENS.some(token => name.startsWith(token));
    });
  }

  // Dedupe: keep the LAST definition of each name (CSS cascade — later
  // declarations override earlier ones, e.g. theme overrides in a second
  // :root block).
  const byName = new Map();
  for (const v of allVars) {
    byName.set(v.slice(0, v.indexOf(':')), v);
  }
  allVars = [...byName.values()];

  return `:root {\n  ${allVars.join('\n  ')}\n}`;
}

// Parse args
const args = process.argv.slice(2);
const minimal = args.includes('--minimal');
const wrapStyle = args.includes('--style');

try {
  const css = fs.readFileSync(tokensPath, 'utf-8');
  let output = extractTokens(css, minimal);

  if (wrapStyle) {
    const safeCss = output.replace(/<\/style/gi, '<\\/style');
    output = `<style>\n/* Design Tokens (embedded for standalone HTML) */\n${safeCss}\n</style>`;
  } else {
    output = `/* Design Tokens (embedded for standalone HTML) */\n${output}`;
  }

  console.log(output);
} catch (err) {
  console.error(`Error reading tokens: ${err.message}`);
  process.exit(1);
}
