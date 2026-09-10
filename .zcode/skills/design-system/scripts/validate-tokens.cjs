#!/usr/bin/env node
/**
 * Validate token usage in codebase
 * Finds hardcoded values that should use design tokens
 *
 * Usage:
 *   node validate-tokens.cjs --dir src/
 */

const fs = require('fs');
const path = require('path');

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    dir: null,
    ignore: ['node_modules', '.git', 'dist', 'build', '.next']
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dir' || args[i] === '-d') {
      const dir = args[++i];
      if (typeof dir !== 'string' || (dir.startsWith('-') && dir !== '-')) {
        console.error('Error: --dir requires a path argument');
        process.exit(1);
      }
      options.dir = dir;
    } else if (args[i] === '--ignore' || args[i] === '-i') {
      const ignoreDir = args[++i];
      if (typeof ignoreDir !== 'string' || (ignoreDir.startsWith('-') && ignoreDir !== '-')) {
        console.error('Error: --ignore requires a directory argument');
        process.exit(1);
      }
      options.ignore.push(ignoreDir);
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node validate-tokens.cjs [options]

Options:
  -d, --dir <path>      Directory to scan (required)
  -i, --ignore <dir>    Additional directories to ignore
  -h, --help            Show this help

Checks for:
  - Hardcoded hex colors (#RGB, #RRGGBB)
  - Hardcoded pixel values (except 0, 1px)
  - Hardcoded rem values in CSS
      `);
      process.exit(0);
    } else {
      console.warn(`Warning: unknown argument '${args[i]}' ignored`);
    }
  }

  return options;
}

/**
 * Patterns to detect hardcoded values
 */
const patterns = {
  hexColor: {
    // Alternation ordered longest-first so 4/8-digit hex is not rejected by
    // the lookahead; 5/7-digit strings (invalid CSS) stay excluded.
    regex: /#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3,4})(?![\w-])/g,
    message: 'Hardcoded hex color',
    suggestion: 'Use var(--color-*) token'
  },
  rgbColor: {
    // Covers rgb()/rgba(), comma and space separated, with percentages and alpha
    regex: /rgba?\(\s*[\d.]+%?\s*[ ,]\s*[\d.]+%?\s*[ ,]\s*[\d.]+%?\s*(?:[,/]\s*[\d.]+%?\s*)?\)/gi,
    message: 'Hardcoded RGB color',
    suggestion: 'Use var(--color-*) token'
  },
  pixelValue: {
    // Match px tokens anywhere on the line so shorthand values
    // (`padding: 8px 16px`) and functional values (`calc(100% - 16px)`)
    // are not missed; 0/1px are exempted in the exception check below
    regex: /['"]?(-?\d+\.?\d*)px\b/g,
    message: 'Hardcoded pixel value',
    suggestion: 'Use var(--space-*) or var(--radius-*) token'
  },
  remValue: {
    regex: /['"]?-?\d+\.?\d*rem\b/g,
    message: 'Hardcoded rem value',
    suggestion: 'Use var(--space-*) or var(--font-size-*) token'
  }
};

// Hex colors that are often intentional (pure black/white)
const HEX_COLOR_WHITELIST = ['#000', '#FFF', '#000000', '#FFFFFF'];

/**
 * File extensions to scan
 */
const extensions = ['.css', '.scss', '.tsx', '.jsx', '.ts', '.js', '.vue', '.svelte'];

/**
 * Basenames of files to skip (token definitions, generated/minified files)
 */
const skipPatterns = [
  /\.min\.(css|js)$/,
  /^tailwind\.config\./,
  /^globals\.css$/, // Token definitions
  /^tokens\.(css|json|js|ts|scss)$/
];

/**
 * Get all files recursively
 */
function getFiles(dir, ignore, files = [], visited = new Set()) {
  // Cycle protection: symlinked directories can loop; skip already-seen
  // resolved paths.
  const realDir = fs.realpathSync(dir);
  if (visited.has(realDir)) return files;
  visited.add(realDir);

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.warn(`Warning: skipping unreadable directory ${dir}: ${err.message}`);
    return files;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    // Dirent.isDirectory() is false for symlinks (lstat semantics) — follow
    // symlinked directories via stat() so they are traversed too.
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = fs.statSync(fullPath).isDirectory();
      } catch {
        // Broken symlink — nothing to traverse
      }
    }

    if (isDir) {
      if (!ignore.includes(entry.name)) {
        getFiles(fullPath, ignore, files, visited);
      }
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name);
      if (extensions.includes(ext)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

/**
 * Check if file should be skipped (by basename, so e.g. /globals\.css/
 * cannot exempt arbitrary paths that merely contain the substring)
 */
function shouldSkip(filePath) {
  const base = path.basename(filePath);
  return skipPatterns.some(pattern => pattern.test(base));
}

/**
 * Scan file for violations
 */
function scanFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.warn(`Warning: skipping unreadable file ${filePath}: ${err.message}`);
    return [];
  }
  const lines = content.split('\n');
  const violations = [];

  let inBlockComment = false;
  lines.forEach((rawLine, index) => {
    // Strip comments: track block-comment state across lines and remove
    // inline comments so commented-out values are not reported.
    let line = rawLine;
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) return;
      inBlockComment = false;
      line = line.slice(end + 2);
    }
    line = line
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Don't treat '//' in URLs (https://, //cdn...) as a comment start
      .replace(/(^|[^:'"])\/\/.*$/, '$1');
    const open = line.indexOf('/*');
    if (open !== -1) {
      inBlockComment = true;
      line = line.slice(0, open);
    }
    if (!line.trim()) return;

    // Remove anchor/URL fragment refs like href="#top" or url(#gradient),
    // then keep scanning the rest of the line for other violations
    line = line.replace(/((?:href|xlink:href|url)\s*[=(]\s*['"]?)#[^'")\s]*/gi, '$1');

    for (const [name, pattern] of Object.entries(patterns)) {
      const matches = line.match(pattern.regex);
      if (matches) {
        matches.forEach(match => {
          // Skip common exceptions
          if (name === 'hexColor' && HEX_COLOR_WHITELIST.includes(match.toUpperCase())) {
            return; // Skip black/white, often intentional
          }
          if (name === 'pixelValue') {
            const px = parseFloat(match.replace(/[^-\d.]/g, ''));
            if (px === 0 || px === 1) {
              return; // Skip 0/1px, often intentional
            }
          }

          violations.push({
            file: filePath,
            line: index + 1,
            value: match,
            type: name,
            message: pattern.message,
            suggestion: pattern.suggestion,
            context: line.trim().substring(0, 80)
          });
        });
      }
    }
  });

  return violations;
}

/**
 * Format violation report
 */
function formatReport(violations) {
  if (violations.length === 0) {
    return '✅ No token violations found';
  }

  let report = `⚠️  Found ${violations.length} potential token violations:\n\n`;

  // Group by file
  const byFile = {};
  violations.forEach(v => {
    if (!byFile[v.file]) byFile[v.file] = [];
    byFile[v.file].push(v);
  });

  for (const [file, fileViolations] of Object.entries(byFile)) {
    report += `📁 ${file}\n`;
    fileViolations.forEach(v => {
      report += `   Line ${v.line}: ${v.message}\n`;
      report += `   Found: ${v.value}\n`;
      report += `   Suggestion: ${v.suggestion}\n`;
      report += `   Context: ${v.context}\n\n`;
    });
  }

  // Summary
  const byType = {};
  violations.forEach(v => {
    byType[v.type] = (byType[v.type] || 0) + 1;
  });

  report += `\n📊 Summary:\n`;
  for (const [type, count] of Object.entries(byType)) {
    report += `   ${patterns[type].message}: ${count}\n`;
  }

  return report;
}

/**
 * Main
 */
function main() {
  const options = parseArgs();

  if (!options.dir) {
    console.error('Error: --dir is required');
    process.exit(1);
  }

  const dirPath = path.resolve(process.cwd(), options.dir);

  // existsSync alone would let a file path through (ENOTDIR is then silently
  // downgraded to a warning, reporting zero violations and a CI success).
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
    console.error(`Error: Directory not found: ${dirPath}`);
    process.exit(1);
  }

  console.log(`Scanning ${dirPath} for token violations...\n`);

  const files = getFiles(dirPath, options.ignore);
  const allViolations = [];

  for (const file of files) {
    if (shouldSkip(file)) continue;

    const violations = scanFile(file);
    allViolations.push(...violations);
  }

  console.log(formatReport(allViolations));

  // Exit with error code if violations found
  if (allViolations.length > 0) {
    process.exit(1);
  }
}

main();
