#!/usr/bin/env node
/**
 * Generate CSS variables from design tokens JSON
 *
 * Usage:
 *   node generate-tokens.cjs --config tokens.json -o tokens.css
 *   node generate-tokens.cjs --config tokens.json --format tailwind
 */

const fs = require('fs');
const path = require('path');

/**
 * Parse command line arguments
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    config: null,
    output: null,
    format: 'css' // css | tailwind
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' || args[i] === '-c') {
      const val = args[++i];
      if (val === undefined || val.startsWith('-')) {
        console.error('Error: --config requires a file path value');
        process.exit(1);
      }
      options.config = val;
    } else if (args[i] === '--output' || args[i] === '-o') {
      const val = args[++i];
      if (val === undefined || val.startsWith('-')) {
        console.error('Error: --output requires a file path value');
        process.exit(1);
      }
      options.output = val;
    } else if (args[i] === '--format' || args[i] === '-f') {
      const format = args[++i];
      if (!['css', 'tailwind'].includes(format)) {
        console.error(`Error: --format must be "css" or "tailwind", got "${format}"`);
        process.exit(1);
      }
      options.format = format;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: node generate-tokens.cjs [options]

Options:
  -c, --config <file>   Input JSON token file (required)
  -o, --output <file>   Output file (default: stdout)
  -f, --format <type>   Output format: css | tailwind (default: css)
  -h, --help            Show this help
      `);
      process.exit(0);
    } else {
      console.error(`Error: unknown option "${args[i]}"`);
      process.exit(1);
    }
  }

  return options;
}

/**
 * Resolve token references like {primitive.color.blue.600}
 */
function resolveReference(value, tokens, seen = new Set()) {
  if (typeof value !== 'string' || !value.startsWith('{')) {
    return value;
  }
  if (!value.endsWith('}')) {
    console.warn(`Warning: malformed token reference "${value}"`);
    return value;
  }

  const refPath = value.slice(1, -1).split('.');
  let result = tokens;

  for (const key of refPath) {
    result = result?.[key];
  }

  if (result === undefined || result === null) {
    console.warn(`Warning: unresolved token reference "${value}"`);
    return value;
  }
  if (typeof result === 'object') {
    if (result.$value === undefined) {
      console.warn(`Warning: reference "${value}" points to a group, not a token`);
      return value;
    }
    if (seen.has(value)) {
      throw new Error(`Circular token reference detected: ${value}`);
    }
    seen.add(value);
    return resolveReference(result.$value, tokens, seen);
  }
  if (typeof result === 'string' && result.startsWith('{') && result.endsWith('}')) {
    // Target stored a bare reference without $value — keep resolving it
    if (seen.has(value)) {
      throw new Error(`Circular token reference detected: ${value}`);
    }
    seen.add(value);
    return resolveReference(result, tokens, seen);
  }
  return result; // preserves valid falsy values like 0 or ''
}

/**
 * Convert token name to CSS variable name
 */
function toCssVarName(segments) {
  return '--' + segments.join('-');
}

/**
 * Flatten tokens into CSS variables
 */
function flattenTokens(obj, tokens, prefix = [], result = {}) {
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = [...prefix, key];

    if (value && typeof value === 'object') {
      if (value.$value !== undefined) {
        // This is a token
        const cssVar = toCssVarName(currentPath);
        const resolvedValue = resolveReference(value.$value, tokens);
        // Unvalidated values could break out of the CSS declaration and
        // inject arbitrary rules — refuse unsafe characters instead.
        if (typeof resolvedValue === 'string' && /[;{}]|\/\*|\*\//.test(resolvedValue)) {
          console.warn(`Warning: token "${cssVar}" contains unsafe CSS characters, skipping: ${resolvedValue}`);
          continue;
        }
        result[cssVar] = resolvedValue;
      } else {
        // Recurse into nested object
        flattenTokens(value, tokens, currentPath, result);
      }
    }
  }

  return result;
}

/**
 * Generate CSS output
 */
function generateCSS(tokens) {
  const primitive = flattenTokens(tokens.primitive || {}, tokens, ['primitive']);
  const semantic = flattenTokens(tokens.semantic || {}, tokens, []);
  const component = flattenTokens(tokens.component || {}, tokens, []);
  const darkSemantic = flattenTokens(tokens.dark?.semantic || {}, tokens, []);

  let css = `/* Design Tokens - Auto-generated */
/* Do not edit directly - modify tokens.json instead */

/* === PRIMITIVES === */
:root {
${Object.entries(primitive).map(([k, v]) => `  ${k}: ${v};`).join('\n')}
}

/* === SEMANTIC === */
:root {
${Object.entries(semantic).map(([k, v]) => `  ${k}: ${v};`).join('\n')}
}

/* === COMPONENTS === */
:root {
${Object.entries(component).map(([k, v]) => `  ${k}: ${v};`).join('\n')}
}
`;

  if (Object.keys(darkSemantic).length > 0) {
    css += `
/* === DARK MODE === */
.dark {
${Object.entries(darkSemantic).map(([k, v]) => `  ${k}: ${v};`).join('\n')}
}
`;
  }

  return css;
}

/**
 * Insert a (possibly hierarchical) color name into the Tailwind colors map.
 * Uses Tailwind's DEFAULT convention so `primary` and `primary-action`
 * coexist regardless of the order the keys are visited.
 */
function insertColorKey(colors, name, value) {
  const parts = name.split('-');
  let node = colors;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof node[part] !== 'object' || node[part] === null) {
      // A previously stored leaf occupies this level — move it under DEFAULT
      node[part] = typeof node[part] === 'string' ? { DEFAULT: node[part] } : {};
    }
    node = node[part];
  }
  const leaf = parts[parts.length - 1];
  if (typeof node[leaf] === 'object' && node[leaf] !== null) {
    node[leaf] = { ...node[leaf], DEFAULT: value };
  } else {
    node[leaf] = value;
  }
}

/**
 * Generate Tailwind config output
 */
function generateTailwind(tokens) {
  const semantic = flattenTokens(tokens.semantic || {}, tokens);
  const COLOR_PREFIX = '--color-';

  // Extract colors for Tailwind
  const colors = {};
  for (const [key, value] of Object.entries(semantic)) {
    if (key.startsWith(COLOR_PREFIX)) {
      // Build nested keys (Tailwind expects nested objects, and a blanket
      // '-' → '.' conversion would conflate hyphenated names with hierarchy)
      insertColorKey(colors, key.slice(COLOR_PREFIX.length), `var(${key})`);
    }
  }

  return `// Tailwind color config - Auto-generated
// Add to tailwind.config.js (CJS) theme.extend.colors

module.exports = {
  colors: ${JSON.stringify(colors, null, 2)}
};
`;
}

/**
 * Main
 */
function main() {
  const options = parseArgs();

  if (!options.config) {
    console.error('Error: --config is required');
    process.exit(1);
  }

  // Resolve config path
  const configPath = path.resolve(process.cwd(), options.config);

  if (!fs.existsSync(configPath)) {
    console.error(`Error: Config file not found: ${configPath}`);
    process.exit(1);
  }

  // Read and parse tokens
  let tokens;
  try {
    tokens = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    console.error(`Error: Failed to parse config file as JSON: ${configPath}`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }

  // Generate output (circular references / malformed token trees throw —
  // surface them as clean CLI errors instead of raw stack traces)
  let output;
  try {
    output = options.format === 'tailwind'
      ? generateTailwind(tokens)
      : generateCSS(tokens);
  } catch (err) {
    console.error(`Error: Failed to generate tokens: ${err.message}`);
    process.exit(1);
  }

  // Write output
  if (options.output) {
    const outputPath = path.resolve(process.cwd(), options.output);
    try {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, output);
    } catch (err) {
      console.error(`Error: Failed to write output file: ${outputPath}`);
      console.error(`  ${err.message}`);
      process.exit(1);
    }
    console.log(`Generated: ${outputPath}`);
  } else {
    console.log(output);
  }
}

main();
