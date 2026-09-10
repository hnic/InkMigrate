#!/usr/bin/env node
/**
 * extract-colors.cjs
 *
 * Extract dominant colors from an image and compare against brand palette.
 * Uses pure Node.js without external image processing dependencies.
 *
 * For full color extraction from images, integrate with ai-multimodal skill
 * or use ImageMagick via shell commands.
 *
 * Usage:
 *   node extract-colors.cjs <image-path>
 *   node extract-colors.cjs <image-path> --brand-file <path>
 *   node extract-colors.cjs --palette  # Show brand palette from guidelines
 *
 * Integration:
 *   For image color analysis, use: ai-multimodal skill or ImageMagick
 *   magick <image> -colors 10 -depth 8 -format "%c" histogram:info:
 */

const fs = require("fs");
const path = require("path");

// Default brand guidelines path (overridable via environment)
const DEFAULT_GUIDELINES_PATH =
  process.env.BRAND_GUIDELINES_PATH || "docs/brand-guidelines.md";

// Brand compliance distance threshold (out of max ~441 for RGB)
const BRAND_DISTANCE_THRESHOLD = 50;

/**
 * Extract hex colors from markdown content.
 * Handles 3-digit shorthand (#FFF), 6-digit (#FFFFFF) and 8-digit
 * with alpha (#RRGGBBAA); shorthand is expanded and alpha is dropped
 * so hexToRgb/colorDistance can compare them.
 */
function extractHexColors(text) {
  const hexPattern = /#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b/g;
  // Only scan lines that look like palette entries (markdown table rows or
  // lines labelled color/hex/rgb), so prose hashtags like "#fad" are ignored.
  const candidateText = text
    .split("\n")
    .filter((line) => /\|/.test(line) || /colou?r|hex|rgb/i.test(line))
    .join("\n");
  const normalize = (hex) => {
    if (hex.length === 4) {
      // Expand shorthand: #abc -> #aabbcc
      return "#" + hex
        .slice(1)
        .split("")
        .map((c) => c + c)
        .join("")
        .toUpperCase();
    }
    // 8-digit form carries alpha; keep the RGB channels
    return "#" + hex.slice(1, 7).toUpperCase();
  };
  return [...new Set((candidateText.match(hexPattern) || []).map(normalize))];
}

/**
 * Parse brand guidelines for color palette
 */
function parseBrandColors(guidelinesPath) {
  const resolvedPath = path.isAbsolute(guidelinesPath)
    ? guidelinesPath
    : path.join(process.cwd(), guidelinesPath);

  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  let content;
  try {
    content = fs.readFileSync(resolvedPath, "utf-8");
  } catch (err) {
    // Distinguish "missing" (returns null) from "unreadable" (throws) so the
    // caller reports the accurate reason.
    throw new Error(`Failed to read brand guidelines: ${resolvedPath} (${err.message})`);
  }

  const palette = {
    primary: [],
    secondary: [],
    neutral: [],
    semantic: [],
    all: [],
  };

  // Extract colors from different sections
  const sections = [
    { name: "primary", regex: /### Primary[\s\S]*?(?=###|##|$)/i },
    { name: "secondary", regex: /### Secondary[\s\S]*?(?=###|##|$)/i },
    { name: "neutral", regex: /### Neutral[\s\S]*?(?=###|##|$)/i },
    { name: "semantic", regex: /### Semantic[\s\S]*?(?=###|##|$)/i },
  ];

  sections.forEach(({ name, regex }) => {
    const match = content.match(regex);
    if (match) {
      const colors = extractHexColors(match[0]);
      palette[name] = colors;
      palette.all.push(...colors);
    }
  });

  // Dedupe all
  palette.all = [...new Set(palette.all)];

  return palette;
}

/**
 * Convert hex to RGB
 */
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

/**
 * Convert RGB to hex
 */
function rgbToHex(r, g, b) {
  return (
    "#" +
    [r, g, b]
      .map((x) => {
        const hex = Math.round(x).toString(16);
        return hex.length === 1 ? "0" + hex : hex;
      })
      .join("")
      .toUpperCase()
  );
}

/**
 * Calculate color distance (Euclidean in RGB space)
 *
 * Accepts hex strings, {r,g,b} objects, or histogram entries ({hex, count}
 * from parseImageMagickOutput), so the exported helpers compose safely.
 */
function colorDistance(color1, color2) {
  const toRgb = (c) =>
    typeof c === "string" || (c && typeof c.hex === "string")
      ? hexToRgb(typeof c === "string" ? c : c.hex)
      : c;
  const rgb1 = toRgb(color1);
  const rgb2 = toRgb(color2);
  const valid = (rgb) =>
    rgb && ["r", "g", "b"].every((k) => Number.isFinite(rgb[k]));

  if (!valid(rgb1) || !valid(rgb2)) return Infinity;

  return Math.sqrt(
    Math.pow(rgb1.r - rgb2.r, 2) +
      Math.pow(rgb1.g - rgb2.g, 2) +
      Math.pow(rgb1.b - rgb2.b, 2)
  );
}

/**
 * Find nearest brand color
 */
function findNearestBrandColor(color, brandColors) {
  let nearest = null;
  let minDistance = Infinity;

  brandColors.forEach((brandColor) => {
    const distance = colorDistance(color, brandColor);
    if (distance < minDistance) {
      minDistance = distance;
      nearest = brandColor;
    }
  });

  return { color: nearest, distance: minDistance };
}

/**
 * Calculate brand compliance percentage
 */
function calculateCompliance(
  extractedColors,
  brandColors,
  threshold = BRAND_DISTANCE_THRESHOLD
) {
  // No extracted colors means no data — report 0 rather than perfect compliance
  if (!extractedColors || extractedColors.length === 0) return 0;
  if (!brandColors || brandColors.length === 0) return 0;

  let matchCount = 0;

  extractedColors.forEach((color) => {
    const nearest = findNearestBrandColor(color, brandColors);
    if (nearest.distance <= threshold) {
      matchCount++;
    }
  });

  return Math.round((matchCount / extractedColors.length) * 100);
}

/**
 * Quote a value for safe interpolation into a shell command.
 * Single quotes are safe for every character except a single quote,
 * which is closed, escaped and reopened as '\''.
 */
function escapeShellArg(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/**
 * Generate ImageMagick command for color extraction
 */
function generateImageMagickCommand(imagePath, numColors = 10) {
  const colors = Number.parseInt(numColors, 10);
  const safeColors = Number.isInteger(colors) ? colors : 10;
  return `magick ${escapeShellArg(imagePath)} -colors ${safeColors} -depth 8 -format "%c" histogram:info:`;
}

/**
 * Parse ImageMagick histogram output to extract colors
 */
function parseImageMagickOutput(output) {
  const colors = [];
  const lines = output.trim().split("\n");

  lines.forEach((line) => {
    // Match pattern like: 12345: (255,128,64) #FF8040 srgb(255,128,64)
    // ImageMagick emits #RRGGBBAA for images with alpha and may print
    // large counts with thousands separators (e.g. "1,234,567:").
    const hexMatch = line.match(/#([0-9A-Fa-f]{6,8})(?![0-9A-Fa-f])/);
    const countMatch = line.match(/^\s*([\d,]+):/);

    if (hexMatch) {
      colors.push({
        // Use only the RGB channels if an alpha channel is present
        hex: "#" + hexMatch[1].slice(0, 6).toUpperCase(),
        count: countMatch ? parseInt(countMatch[1].replace(/,/g, ""), 10) : 0,
      });
    }
  });

  // Sort by count (most common first)
  colors.sort((a, b) => b.count - a.count);

  return colors;
}

/**
 * Display brand palette
 */
function displayPalette(palette) {
  console.log("\n" + "=".repeat(50));
  console.log("BRAND COLOR PALETTE");
  console.log("=".repeat(50));

  if (palette.primary.length > 0) {
    console.log("\nPrimary Colors:");
    palette.primary.forEach((c) => console.log(`  ${c}`));
  }

  if (palette.secondary.length > 0) {
    console.log("\nSecondary Colors:");
    palette.secondary.forEach((c) => console.log(`  ${c}`));
  }

  if (palette.neutral.length > 0) {
    console.log("\nNeutral Colors:");
    palette.neutral.forEach((c) => console.log(`  ${c}`));
  }

  if (palette.semantic.length > 0) {
    console.log("\nSemantic Colors:");
    palette.semantic.forEach((c) => console.log(`  ${c}`));
  }

  console.log("\n" + "=".repeat(50));
  console.log(`Total: ${palette.all.length} colors in brand palette`);
  console.log("=".repeat(50) + "\n");
}

/**
 * Main function
 */
function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const showPalette = args.includes("--palette");
  let brandFile = DEFAULT_GUIDELINES_PATH;
  // Parse positionally: consume --brand-file's value while scanning, so the
  // first remaining non-flag token is unambiguously the image path.
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--brand-file") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) {
        console.error("Error: --brand-file requires a path argument");
        process.exit(1);
      }
      brandFile = value;
      i += 1;
    } else if (!args[i].startsWith("--")) {
      positional.push(args[i]);
    }
  }
  const imagePath = positional[0];

  // Load brand palette
  let brandPalette;
  try {
    brandPalette = parseBrandColors(brandFile);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (!brandPalette) {
    console.error(`Brand guidelines not found at: ${brandFile}`);
    console.error(`Create brand guidelines or specify path with --brand-file`);
    process.exit(1);
  }

  // Show palette mode
  if (showPalette || !imagePath) {
    if (jsonOutput) {
      console.log(JSON.stringify(brandPalette, null, 2));
    } else {
      displayPalette(brandPalette);

      if (!imagePath) {
        console.log("To extract colors from an image:");
        console.log("  node extract-colors.cjs <image-path>");
        console.log("\nOr use ImageMagick directly:");
        console.log('  magick image.png -colors 10 -depth 8 -format "%c" histogram:info:');
      }
    }
    return;
  }

  // Resolve image path
  const resolvedPath = path.isAbsolute(imagePath)
    ? imagePath
    : path.join(process.cwd(), imagePath);

  if (!fs.existsSync(resolvedPath)) {
    console.error(`Image not found: ${resolvedPath}`);
    process.exit(1);
  }

  // Generate extraction instructions
  const extractionCommand = generateImageMagickCommand(resolvedPath);
  const instructions = [
    "1. Run the ImageMagick command to extract colors:",
    `   ${extractionCommand}`,
    "",
  ];

  // The ai-multimodal skill's location varies by project layout — only
  // suggest it when the script is actually present.
  const multimodalScript = [
    ".zcode/skills/ai-multimodal/scripts/gemini_batch_process.py",
    ".claude/skills/ai-multimodal/scripts/gemini_batch_process.py",
  ]
    .map((p) => path.resolve(process.cwd(), p))
    .find((p) => fs.existsSync(p));
  if (multimodalScript) {
    instructions.push(
      "2. Or use the ai-multimodal skill:",
      `   python "${multimodalScript}" \\`,
      `     --files "${resolvedPath}" \\`,
      `     --task analyze \\`,
      `     --prompt "Extract the 10 most dominant colors as hex values"`,
      ""
    );
  }
  instructions.push(
    `${multimodalScript ? "3" : "2"}. Then compare extracted colors against brand palette`
  );

  const result = {
    image: resolvedPath,
    brandPalette: brandPalette,
    extractionCommand,
    instructions,
    complianceCheck: {
      threshold: BRAND_DISTANCE_THRESHOLD,
      description: `Colors within distance ${BRAND_DISTANCE_THRESHOLD} (RGB space) are considered brand-compliant`,
      brandColors: brandPalette.all,
    },
  };

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log("\n" + "=".repeat(60));
    console.log("COLOR EXTRACTION HELPER");
    console.log("=".repeat(60));
    console.log(`\nImage: ${result.image}`);
    console.log(`\nBrand Colors: ${brandPalette.all.length} colors loaded`);
    console.log("\nTo extract colors from this image:\n");
    result.instructions.forEach((line) => console.log(line));
    console.log("\n" + "=".repeat(60));

    // Show brand palette for reference
    console.log("\nBrand Palette Reference:");
    console.log(`  Primary: ${brandPalette.primary.join(", ") || "none"}`);
    console.log(`  Secondary: ${brandPalette.secondary.join(", ") || "none"}`);
    console.log(`  Neutral: ${brandPalette.neutral.join(", ") || "none"}`);
    console.log(`  Semantic: ${brandPalette.semantic.join(", ") || "none"}`);
    console.log("=".repeat(60) + "\n");
  }
}

// Export functions for use as module
module.exports = {
  parseBrandColors,
  hexToRgb,
  rgbToHex,
  colorDistance,
  findNearestBrandColor,
  calculateCompliance,
  parseImageMagickOutput,
};

// Run if called directly
if (require.main === module) {
  main();
}
