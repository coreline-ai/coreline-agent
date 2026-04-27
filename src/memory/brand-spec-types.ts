/**
 * brand-spec memory type — concept inspired by huashu-design.
 * https://github.com/alchaincyf/huashu-design (Personal Use License)
 * Implementation written independently.
 */

export interface BrandSpecFields {
  /** Brand name (entity slug). */
  name: string;
  /** Logo asset path or URL. */
  logo?: string;
  /** Primary brand color (hex, oklch, or CSS). */
  primaryColor?: string;
  /** Single accent color. */
  accentColor?: string;
  /** Background color (e.g., #F5F4F0 cream, #000 black). */
  backgroundColor?: string;
  /** Display/heading font (serif preferred). */
  displayFont?: string;
  /** Body font (sans-serif). */
  bodyFont?: string;
  /** Monospace font for code. */
  monoFont?: string;
  /** 3-5 tone/mood adjectives. */
  tone?: string[];
  /** Explicit forbidden patterns (anti-AI-slop). */
  doNotUse?: string[];
  /** Free-form additional notes. */
  notes?: string;
}

export interface BrandSpecValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}
