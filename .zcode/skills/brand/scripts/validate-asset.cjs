#!/usr/bin/env node
/**
 * validate-asset.cjs
 *
 * Validates marketing assets against brand guidelines.
 * Checks: file naming, file format, file size.
 *
 * Usage:
 *   node validate-asset.cjs <asset-path>
 *   node validate-asset.cjs <asset-path> --json
 *
 * For color validation of images, use with extract-colors.cjs
 */

const fs = require("fs");
const path = require("path");

// Validation rules
const RULES = {
  naming: {
    pattern: /^[a-z]+_[a-z0-9-]+_[a-z0-9-]+_\d{8}(_[a-z0-9-]+)?\.[a-z]+$/,
    description:
      "{type}_{campaign}_{description}_{timestamp}_{variant}.{ext}",
    examples: [
      "banner_claude-launch_hero-image_20251209.png",
      "logo_brand-refresh_horizontal_20251209_dark.svg",
    ],
  },
  types: ["banner", "logo", "design", "video", "infographic", "icon", "photo"],
  fileSize: {
    image: { max: 5 * 1024 * 1024, recommended: 1 * 1024 * 1024 },
    video: { max: 100 * 1024 * 1024, recommended: 50 * 1024 * 1024 },
    svg: { max: 500 * 1024, recommended: 100 * 1024 },
  },
  formats: {
    image: ["png", "jpg", "jpeg", "webp", "gif"],
    vector: ["svg"],
    video: ["mp4", "mov", "webm"],
    document: ["pdf", "psd", "ai", "fig"],
  },
};

/**
 * Parse asset filename
 */
function parseFilename(filename) {
  const parts = filename.replace(/\.[^.]+$/, "").split("_");

  if (parts.length < 4) {
    return null;
  }

  return {
    type: parts[0],
    campaign: parts[1],
    description: parts[2],
    timestamp: parts[3],
    variant: parts.length > 4 ? parts[4] : null,
    extension: path.extname(filename).slice(1).toLowerCase(),
  };
}

/**
 * Validate filename convention
 */
function validateFilename(filename) {
  const issues = [];
  const suggestions = [];

  // Check pattern match
  if (!RULES.naming.pattern.test(filename)) {
    issues.push("Filename does not match naming convention");
    suggestions.push(`Expected format: ${RULES.naming.description}`);
    suggestions.push(`Examples: ${RULES.naming.examples.join(", ")}`);
  }

  // Parse and check components
  const parsed = parseFilename(filename);
  if (parsed) {
    // Check timestamp format
    if (!/^\d{8}$/.test(parsed.timestamp)) {
      issues.push("Timestamp should be YYYYMMDD format");
    }

    // Check kebab-case for campaign and description
    if (parsed.campaign && !/^[a-z0-9-]+$/.test(parsed.campaign)) {
      issues.push("Campaign name should be kebab-case");
    }

    if (parsed.description && !/^[a-z0-9-]+$/.test(parsed.description)) {
      issues.push("Description should be kebab-case");
    }

    // Check valid type
    const validTypes = RULES.types;
    if (!validTypes.includes(parsed.type)) {
      suggestions.push(`Consider using type: ${validTypes.join(", ")}`);
    }
  }

  return { valid: issues.length === 0, issues, suggestions, parsed };
}

/**
 * Validate file size
 */
function validateFileSize(filepath, extension) {
  const issues = [];
  const warnings = [];

  // Handle stat failures (TOCTOU/unreadable) and non-regular files cleanly
  // instead of crashing with a raw stack trace.
  let stats;
  try {
    stats = fs.statSync(filepath);
  } catch (err) {
    return {
      valid: false,
      issues: [`Unable to read file stats (${err.code || err.message})`],
      warnings,
      size: 0,
    };
  }
  if (!stats.isFile()) {
    return {
      valid: false,
      issues: ["Path is not a regular file"],
      warnings,
      size: 0,
    };
  }
  const size = stats.size;

  let limits;
  if (RULES.formats.video.includes(extension)) {
    limits = RULES.fileSize.video;
  } else if (extension === "svg") {
    limits = RULES.fileSize.svg;
  } else {
    limits = RULES.fileSize.image;
  }

  if (size > limits.max) {
    issues.push(
      `File size (${formatBytes(size)}) exceeds maximum (${formatBytes(
        limits.max
      )})`
    );
  } else if (size > limits.recommended) {
    warnings.push(
      `File size (${formatBytes(size)}) exceeds recommended (${formatBytes(
        limits.recommended
      )})`
    );
  }

  return { valid: issues.length === 0, issues, warnings, size };
}

/**
 * Validate file format
 */
function validateFormat(extension) {
  const issues = [];
  const info = { category: null };

  const allFormats = [
    ...RULES.formats.image,
    ...RULES.formats.vector,
    ...RULES.formats.video,
    ...RULES.formats.document,
  ];

  if (!allFormats.includes(extension)) {
    issues.push(`Unsupported file format: .${extension}`);
    return { valid: false, issues, info };
  }

  // Determine category
  if (RULES.formats.image.includes(extension)) info.category = "image";
  else if (RULES.formats.vector.includes(extension)) info.category = "vector";
  else if (RULES.formats.video.includes(extension)) info.category = "video";
  else if (RULES.formats.document.includes(extension))
    info.category = "document";

  return { valid: true, issues, info };
}

/**
 * Check if asset exists in manifest
 */
function checkManifest(filepath) {
  const manifestPath = path.join(process.cwd(), ".assets", "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    return { registered: false, message: "Manifest not found" };
  }

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    // Normalize both sides (resolved, forward slashes) so Windows separators
    // and relative-path spellings don't cause false "not registered" hits.
    const normalize = (p) =>
      path.resolve(process.cwd(), p).split(path.sep).join("/");
    const target = normalize(filepath);
    const found = (manifest.assets || []).find(
      (a) => a?.path && normalize(a.path) === target
    );

    return {
      registered: !!found,
      message: found ? "Asset registered in manifest" : "Asset not in manifest",
      asset: found,
    };
  } catch {
    return { registered: false, message: "Error reading manifest" };
  }
}

/**
 * Generate suggested filename
 */
function suggestFilename(original, parsed) {
  if (!parsed) return null;

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  // Normalize components so the suggestion itself satisfies the naming
  // pattern, and reuse the original timestamp/variant when already valid.
  const kebab = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const type = kebab(parsed.type || "asset");
  const campaign = kebab(parsed.campaign || "general");
  const description = kebab(parsed.description || "untitled");
  const timestamp = /^\d{8}$/.test(parsed.timestamp || "") ? parsed.timestamp : today;
  const variant = parsed.variant ? `_${kebab(parsed.variant)}` : "";
  const ext = (parsed.extension || "png").toLowerCase();

  return `${type}_${campaign}_${description}_${timestamp}${variant}.${ext}`;
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

/**
 * Main validation function
 */
function validateAsset(assetPath) {
  const results = {
    path: assetPath,
    filename: path.basename(assetPath),
    valid: true,
    issues: [],
    warnings: [],
    suggestions: [],
    checks: {},
  };

  // Check file exists
  if (!fs.existsSync(assetPath)) {
    results.valid = false;
    results.issues.push(`File not found: ${assetPath}`);
    return results;
  }

  const filename = path.basename(assetPath);
  const extension = path.extname(filename).slice(1).toLowerCase();

  // 1. Validate filename
  const filenameResult = validateFilename(filename);
  results.checks.filename = filenameResult;
  if (!filenameResult.valid) {
    results.issues.push(...filenameResult.issues);
    results.suggestions.push(...filenameResult.suggestions);
  }

  // 2. Validate format
  const formatResult = validateFormat(extension);
  results.checks.format = formatResult;
  if (!formatResult.valid) {
    results.issues.push(...formatResult.issues);
  }

  // 3. Validate file size
  const sizeResult = validateFileSize(assetPath, extension);
  results.checks.fileSize = sizeResult;
  if (!sizeResult.valid) {
    results.issues.push(...sizeResult.issues);
  }
  results.warnings.push(...sizeResult.warnings);

  // 4. Check manifest registration
  const manifestResult = checkManifest(assetPath);
  results.checks.manifest = manifestResult;
  if (!manifestResult.registered) {
    results.warnings.push("Asset not registered in manifest.json");
    results.suggestions.push(
      "Register asset in .assets/manifest.json for tracking"
    );
  }

  // 5. Suggest corrected filename if needed
  if (!filenameResult.valid && filenameResult.parsed) {
    const suggested = suggestFilename(filename, filenameResult.parsed);
    if (suggested) {
      results.suggestions.push(`Suggested filename: ${suggested}`);
    }
  }

  // Overall validity
  results.valid = results.issues.length === 0;

  return results;
}

/**
 * Format output for console
 */
function formatOutput(results) {
  const lines = [];

  lines.push("\n" + "=".repeat(60));
  lines.push(`ASSET VALIDATION: ${results.filename}`);
  lines.push("=".repeat(60));

  lines.push(`\nStatus: ${results.valid ? "PASS" : "FAIL"}`);
  lines.push(`Path: ${results.path}`);

  if (results.issues.length > 0) {
    lines.push("\nISSUES:");
    results.issues.forEach((issue) => lines.push(`  - ${issue}`));
  }

  if (results.warnings.length > 0) {
    lines.push("\nWARNINGS:");
    results.warnings.forEach((warning) => lines.push(`  - ${warning}`));
  }

  if (results.suggestions.length > 0) {
    lines.push("\nSUGGESTIONS:");
    results.suggestions.forEach((suggestion) =>
      lines.push(`  - ${suggestion}`)
    );
  }

  // File size info
  if (typeof results.checks.fileSize?.size === "number") {
    lines.push(`\nFile Size: ${formatBytes(results.checks.fileSize.size)}`);
  }

  lines.push("\n" + "=".repeat(60));

  return lines.join("\n");
}

/**
 * Main
 */
function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const assetPath = args.find((a) => !a.startsWith("--"));

  if (!assetPath) {
    console.error("Usage: node validate-asset.cjs <asset-path> [--json]");
    console.error("\nExamples:");
    console.error(
      "  node validate-asset.cjs assets/banners/social-media/banner_launch_hero_20251209.png"
    );
    console.error(
      "  node validate-asset.cjs assets/logos/icon-only/logo-icon.svg --json"
    );
    process.exit(1);
  }

  // Resolve path
  const resolvedPath = path.isAbsolute(assetPath)
    ? assetPath
    : path.join(process.cwd(), assetPath);

  // Validate
  const results = validateAsset(resolvedPath);

  // Output
  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log(formatOutput(results));
  }

  // Exit with appropriate code
  process.exit(results.valid ? 0 : 1);
}

main();
