/**
 * AI slop pattern detector — patterns adapted from huashu-design content guidelines.
 * https://github.com/alchaincyf/huashu-design (Personal Use License)
 * Pattern descriptions and suggestions written independently.
 */

export interface SlopMatch {
  matchedText?: string;
  line?: number;
}

export interface SlopPattern {
  id: string;
  description: string;
  detect: (content: string) => SlopMatch | null;
  suggestion: string;
  severity: "warning" | "error";
}

/**
 * 10 heuristic patterns that flag common "AI slop" signals in HTML/CSS/UX content.
 * Each pattern is a regex-based detector; patterns are best-effort signals,
 * not strict rules — false positives are possible.
 */
export const SLOP_PATTERNS: SlopPattern[] = [
  {
    id: "purple-gradient",
    description: "Generic purple/pink/blue gradient — overused AI default",
    severity: "warning",
    detect: (s) => {
      // Purple/pink/magenta hex heuristic: high red (>=0x80) + low green (<0x60)
      // + high blue (>=0x80). Matches #9333ea, #ec4899, #a855f7, #d946ef while
      // skipping warm reds like #ff6633 / #f08080 (green channel too high).
      const purplishHex = /#[89a-f][0-9a-f][0-5][0-9a-f][89a-f][0-9a-f]/i;
      const re = new RegExp(
        `linear-gradient\\([^)]*(?:purple|magenta|violet|fuchsia|${purplishHex.source}|hsl\\(\\s*27[0-9])`,
        "i",
      );
      const m = s.match(re);
      return m ? { matchedText: m[0].slice(0, 80) } : null;
    },
    suggestion:
      "Use single-color gradients or flat brand colors from your palette",
  },
  {
    id: "decorative-emoji",
    description: "Decorative emoji as visual anchor (not content)",
    severity: "warning",
    detect: (s) => {
      const re =
        /(?:^#+\s|<h[1-6][^>]*>)[^\n]*([\u{1F680}\u{26A1}\u{2728}\u{1F3AF}\u{1F4A1}])/mu;
      const m = s.match(re);
      return m ? { matchedText: m[0].slice(0, 80) } : null;
    },
    suggestion:
      "Use icon library (Lucide/Heroicons) for visual anchors, or remove",
  },
  {
    id: "rounded-card-left-accent",
    description: "Rounded card + left border accent (Material clone)",
    severity: "warning",
    detect: (s) => {
      const re =
        /\.card\s*{[^}]*border-radius:\s*(?:8|12|16)px[^}]*border-left:\s*[24]px\s+solid/is;
      const m = s.match(re);
      return m ? { matchedText: m[0].slice(0, 100) } : null;
    },
    suggestion:
      "Use background contrast or typography weight for hierarchy instead of border accent",
  },
  {
    id: "inter-display-font",
    description: "Inter as primary display font without serif pairing (AI default)",
    severity: "warning",
    detect: (s) => {
      const hasInter = /font-family:\s*['"]?Inter['"]?/i.test(s);
      const hasSerif =
        /font-family[^;]*['"]?(Source\s+Serif|Instrument|Fraunces|Cormorant|Playfair|Noto\s+Serif)['"]?/i.test(
          s,
        );
      if (hasInter && !hasSerif) {
        return { matchedText: "Inter without serif display pairing" };
      }
      return null;
    },
    suggestion:
      "Pair a serif display font (Source Serif 4 / Instrument Serif / Fraunces) with Inter body",
  },
  {
    id: "generic-cliche-words",
    description:
      "Generic AI cliché phrases (seamlessly, leverage, robust solution, ...)",
    severity: "warning",
    detect: (s) => {
      const re =
        /\b(seamlessly|leverage|robust solution|cutting-edge|state-of-the-art|harness the power|unlock|elevate)\b/gi;
      const m = s.match(re);
      return m ? { matchedText: m[0] } : null;
    },
    suggestion:
      "Use specific, concrete language tied to your actual outcomes",
  },
  {
    id: "neon-on-dark-bg",
    description: "Neon green/cyan on pitch black — overused cyber-aesthetic",
    severity: "warning",
    detect: (s) => {
      const re = /background[^;]*#000[^;]*;[^}]*color[^;]*#(?:00ff|0ff)/i;
      const m = s.match(re);
      return m ? { matchedText: m[0].slice(0, 80) } : null;
    },
    suggestion:
      "Use brand-aligned colors with measured contrast (WCAG AA 4.5:1)",
  },
  {
    id: "bento-grid-overuse",
    description: "Bento-grid card layout used as default for everything",
    severity: "warning",
    detect: (s) => {
      const re =
        /(?:border-radius:\s*\d+px[^}]*box-shadow[^;]*0\s+\d+px[^}]*}\s*){4,}/is;
      const m = s.match(re);
      return m ? { matchedText: "4+ stacked card patterns detected" } : null;
    },
    suggestion:
      "Vary layout types — use lists, comparisons, or hierarchy where appropriate",
  },
  {
    id: "excessive-color-palette",
    description: "More than 5 distinct hex colors (palette discipline broken)",
    severity: "warning",
    detect: (s) => {
      const colors = s.match(/#[0-9a-fA-F]{3,6}\b/g) ?? [];
      const unique = new Set(colors.map((c) => c.toLowerCase()));
      return unique.size > 5
        ? { matchedText: `${unique.size} distinct colors` }
        : null;
    },
    suggestion:
      "Limit palette to 3-4 colors max (1 primary + 1 accent + 1-2 neutrals)",
  },
  {
    id: "multiple-display-fonts",
    description:
      "More than 2 distinct display fonts loaded (typography clutter)",
    severity: "warning",
    detect: (s) => {
      const fonts = (s.match(/font-family:\s*([^;,}]+)/gi) ?? []).map((m) =>
        m.toLowerCase(),
      );
      const unique = new Set(fonts);
      return unique.size > 3
        ? { matchedText: `${unique.size} distinct font-families` }
        : null;
    },
    suggestion:
      "Use 2 fonts max — 1 display (serif) + 1 body (sans-serif)",
  },
  {
    id: "lorem-ipsum-content",
    description: "Lorem ipsum placeholder content (forgot to replace)",
    severity: "error",
    detect: (s) => {
      const re = /Lorem\s+ipsum\s+dolor\s+sit\s+amet/i;
      const m = s.match(re);
      return m ? { matchedText: m[0] } : null;
    },
    suggestion: "Replace lorem ipsum with real content before shipping",
  },
];
