#!/usr/bin/env node
/**
 * inject-brand-context.cjs
 *
 * Extracts brand context from markdown brand guidelines
 * and outputs a formatted system prompt addition.
 *
 * Usage:
 *   node inject-brand-context.cjs [path-to-guidelines]
 *   node inject-brand-context.cjs --json [path-to-guidelines]
 *
 * Default path: docs/brand-guidelines.md
 */

const fs = require("fs");
const path = require("path");

// Default brand guidelines path
const DEFAULT_GUIDELINES_PATH = "docs/brand-guidelines.md";

/**
 * Extract hex colors from text.
 * Longest-first alternation so 8-digit alpha values are not rejected by \b.
 */
function extractHexColors(text) {
  const hexPattern = /#(?:[0-9A-Fa-f]{8}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b/g;
  return [...new Set(text.match(hexPattern) || [])];
}

/**
 * Isolate a "### <title>" section: from the heading line up to the next
 * heading (any level). Lines inside fenced code blocks are skipped so a
 * '#' comment within ``` cannot truncate the section (which would break
 * fenced-content extraction such as base/example prompts).
 */
function findSection(content, title) {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startRe = new RegExp(`^###\\s+${escapedTitle}\\b[^\\n]*$`, "im");
  const start = startRe.exec(content);
  if (!start) return "";
  const rest = content.slice(start.index + start[0].length);
  let inFence = false;
  let offset = 0;
  for (const line of rest.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
    } else if (!inFence && /^#{1,6}\s/.test(line)) {
      return rest.slice(0, offset);
    }
    offset += line.length + 1;
  }
  return rest;
}

/**
 * Parse a markdown table: return its rows with the separator row removed.
 * Callers drop the header row via slice(1) as appropriate.
 */
function parseMarkdownTable(section) {
  return (section.match(/^\|.+\|$/gm) || []).filter(
    (row) => !/^\|[\s:|-]+\|$/.test(row)
  );
}

/**
 * Extract color data from markdown table
 */
function extractColorsFromTable(content) {
  return {
    primary: extractHexColors(findSection(content, "Primary Colors")),
    secondary: extractHexColors(findSection(content, "Secondary Colors")),
    neutral: extractHexColors(findSection(content, "Neutral")),
    semantic: extractHexColors(findSection(content, "Semantic")),
  };
}

/**
 * Extract typography info
 */
function extractTypography(content) {
  const typography = {
    heading: null,
    body: null,
    mono: null,
  };

  // Look for font definitions
  const headingMatch = content.match(/--font-heading:\s*['"]([^'"]+)['"]/);
  const bodyMatch = content.match(/--font-body:\s*['"]([^'"]+)['"]/);
  const monoMatch = content.match(/--font-mono:\s*['"]([^'"]+)['"]/);

  // Fallback: look in tables
  const stackText = findSection(content, "Font Stack");
  if (stackText) {
    // Keep the gap on a single line and free of quotes/pipes so the match
    // cannot jump to an unrelated quoted string further away.
    const headingAlt = stackText.match(/\bheading[^'"\n|]{0,80}['"]([^'"\n]+)['"]/i);
    const bodyAlt = stackText.match(/\bbody[^'"\n|]{0,80}['"]([^'"\n]+)['"]/i);

    if (headingAlt) typography.heading = headingAlt[1];
    if (bodyAlt) typography.body = bodyAlt[1];
  }

  if (headingMatch) typography.heading = headingMatch[1];
  if (bodyMatch) typography.body = bodyMatch[1];
  if (monoMatch) typography.mono = monoMatch[1];

  return typography;
}

/**
 * Extract voice/tone information
 */
function extractVoice(content) {
  const voice = {
    traits: [],
    prohibited: [],
    personality: "",
  };

  // Extract personality traits from table
  const personalitySection = findSection(content, "Brand Personality");
  if (personalitySection) {
    const traits = personalitySection.match(
      /\*\*([^*]+)\*\*\s*\|\s*([^|]+)/g
    );
    if (traits) {
      voice.traits = traits.map((t) => {
        const match = t.match(/\*\*([^*]+)\*\*/);
        return match ? match[1].trim() : "";
      }).filter(Boolean);
    }
  }

  // Extract prohibited terms. Parse table rows structurally: drop the
  // separator row by pattern and the header row by position, so header
  // labels are never emitted as terms.
  const prohibitedSection = findSection(content, "Prohibited");
  if (prohibitedSection) {
    voice.prohibited = parseMarkdownTable(prohibitedSection)
      .slice(1) // header row
      .map((row) => row.split("|")[1]?.trim())
      .filter(Boolean);
  }

  // Fallback: look for Forbidden Phrases
  const forbiddenSection = findSection(content, "Forbidden Phrases");
  if (forbiddenSection && voice.prohibited.length === 0) {
    const items = forbiddenSection.match(/-\s*["']?([^"'\n(]+)/g);
    if (items) {
      voice.prohibited = items
        .map((item) => item.replace(/^-\s*["']?/, "").trim())
        .filter(Boolean);
    }
  }

  voice.personality = voice.traits.join(", ");

  return voice;
}

/**
 * Extract core attributes
 */
function extractCoreAttributes(content) {
  const attributes = [];

  const attributesSection = findSection(content, "Core Attributes");
  if (attributesSection) {
    const rows = attributesSection.match(
      /\|\s*\*\*([^*]+)\*\*\s*\|\s*([^|]+)\|/g
    );
    if (rows) {
      rows.forEach((row) => {
        const match = row.match(/\*\*([^*]+)\*\*\s*\|\s*([^|]+)/);
        if (match) {
          attributes.push({
            name: match[1].trim(),
            description: match[2].trim(),
          });
        }
      });
    }
  }

  return attributes;
}

/**
 * Extract AI image generation context
 */
function extractImageStyle(content) {
  const imageStyle = {
    basePrompt: "",
    keywords: [],
    mood: [],
    donts: [],
    examplePrompts: [],
  };

  // Extract base prompt template (content between ``` blocks after "Base Prompt Template")
  const basePromptSection = findSection(content, "Base Prompt Template");
  if (basePromptSection) {
    const basePromptMatch = basePromptSection.match(/```\n?([\s\S]*?)```/);
    if (basePromptMatch) {
      imageStyle.basePrompt = basePromptMatch[1].trim().replace(/\n/g, " ");
    }
  }

  // Extract style keywords from table
  const keywordsSection = findSection(content, "Style Keywords");
  if (keywordsSection) {
    const keywordRows = keywordsSection.match(/\|\s*\*\*[^*]+\*\*\s*\|\s*([^|]+)\|/g);
    if (keywordRows) {
      keywordRows.forEach((row) => {
        const match = row.match(/\|\s*\*\*[^*]+\*\*\s*\|\s*([^|]+)\|/);
        if (match) {
          const keywords = match[1].split(",").map((k) => k.trim()).filter(Boolean);
          imageStyle.keywords.push(...keywords);
        }
      });
    }
  }

  // Extract visual mood descriptors (bullet points)
  const moodSection = findSection(content, "Visual Mood Descriptors");
  if (moodSection) {
    const moodItems = moodSection.match(/-\s*([^\n]+)/g);
    if (moodItems) {
      imageStyle.mood = moodItems.map((item) => item.replace(/^-\s*/, "").trim());
    }
  }

  // Extract visual don'ts from table. Parse rows structurally (drop the
  // separator and header rows) instead of filtering by content substrings.
  const dontsSection = findSection(content, "Visual Don'ts");
  if (dontsSection) {
    parseMarkdownTable(dontsSection)
      .slice(1) // header row
      .forEach((row) => {
        const cell = row.split("|")[1]?.trim();
        if (cell) {
          imageStyle.donts.push(cell);
        }
      });
  }

  // Extract example prompts (content between ``` blocks after specific headers)
  const exampleSection = findSection(content, "Example Prompts");
  if (exampleSection) {
    const prompts = exampleSection.match(/\*\*([^*]+)\*\*:\s*```\n?([\s\S]*?)```/g);
    if (prompts) {
      prompts.forEach((p) => {
        const match = p.match(/\*\*([^*]+)\*\*:\s*```\n?([\s\S]*?)```/);
        if (match) {
          imageStyle.examplePrompts.push({
            type: match[1].trim(),
            prompt: match[2].trim().replace(/\n/g, " "),
          });
        }
      });
    }
  }

  return imageStyle;
}

/**
 * Generate system prompt addition
 */
function generatePromptAddition(brandContext) {
  const { colors, typography, voice, attributes, imageStyle } = brandContext;

  let prompt = `
BRAND CONTEXT:
==============

VISUAL IDENTITY:
- Primary Colors: ${colors.primary.join(", ") || "Not specified"}
- Secondary Colors: ${colors.secondary.join(", ") || "Not specified"}
- Neutral Colors: ${colors.neutral.join(", ") || "Not specified"}
- Semantic Colors: ${colors.semantic.join(", ") || "Not specified"}
- Typography: ${typography.heading || typography.body || "System fonts"}${typography.mono ? ` (mono: ${typography.mono})` : ""}

BRAND VOICE:
- Personality: ${voice.personality || "Professional"}
- Core Attributes: ${attributes.map((a) => a.name).join(", ") || "Not specified"}

CONTENT RULES:
- Prohibited Terms: ${voice.prohibited.join(", ") || "None specified"}
`;

  // Add image style context if available
  if (imageStyle && imageStyle.basePrompt) {
    prompt += `
IMAGE GENERATION:
- Base Prompt: ${imageStyle.basePrompt}
- Style Keywords: ${imageStyle.keywords.slice(0, 10).join(", ") || "Not specified"}
- Visual Mood: ${imageStyle.mood.slice(0, 5).join("; ") || "Not specified"}
- Avoid: ${imageStyle.donts.join(", ") || "None specified"}
`;
  }

  prompt += `
Apply these brand guidelines to all generated content.
Maintain consistent voice, colors, and messaging.
`;

  return prompt.trim();
}

/**
 * Main function
 */
function main() {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const guidelinesPath = args.find((a) => !a.startsWith("--")) || DEFAULT_GUIDELINES_PATH;

  // Resolve path
  const resolvedPath = path.isAbsolute(guidelinesPath)
    ? guidelinesPath
    : path.join(process.cwd(), guidelinesPath);

  // Check if file exists
  if (!fs.existsSync(resolvedPath)) {
    console.error(`Error: Brand guidelines not found at ${resolvedPath}`);
    console.error(`Create brand guidelines at ${DEFAULT_GUIDELINES_PATH} or specify a path.`);
    process.exit(1);
  }

  // Read file
  let content;
  try {
    content = fs.readFileSync(resolvedPath, "utf-8");
  } catch (err) {
    console.error(`Error: Unable to read brand guidelines at ${resolvedPath}`);
    console.error(err.message);
    process.exit(1);
  }

  // Extract brand context
  const brandContext = {
    colors: extractColorsFromTable(content),
    typography: extractTypography(content),
    voice: extractVoice(content),
    attributes: extractCoreAttributes(content),
    imageStyle: extractImageStyle(content),
    source: resolvedPath,
    extractedAt: new Date().toISOString(),
  };

  // Output
  if (jsonOutput) {
    console.log(JSON.stringify(brandContext, null, 2));
  } else {
    console.log(generatePromptAddition(brandContext));
  }
}

main();
