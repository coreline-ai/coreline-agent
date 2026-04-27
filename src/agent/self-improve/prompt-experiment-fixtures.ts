/**
 * Design philosophy fixtures for prompt experiments.
 * Conceptually inspired by huashu-design's design philosophy taxonomy.
 * https://github.com/alchaincyf/huashu-design (Personal Use License)
 * All philosophy descriptions reinterpreted independently as coding principles.
 */

import { registerExperiment } from "./prompt-experiment.js";

export interface DesignPhilosophyFixture {
  /** Variant id (slug). */
  id: string;
  /** Display name. */
  name: string;
  /** Origin philosophy reference (general design term, used for attribution only). */
  philosophyOrigin: string;
  /** Reinterpretation as coding/documentation principle (written independently). */
  prompt: string;
  /** Category for grouping. */
  category: "system" | "minimalism" | "generative" | "diagrammatic";
  /** When this style works best. */
  bestFor: string[];
}

/**
 * Five hand-picked design philosophies, each reinterpreted as a coding/documentation
 * principle. Chosen to span systemic, minimalist, generative, and diagrammatic axes.
 *
 * NOTE: These prompts are independent reinterpretations. No text is copied from
 * huashu-design's `references/design-styles.md` or related materials.
 */
export const DESIGN_PHILOSOPHY_FIXTURES: DesignPhilosophyFixture[] = [
  {
    id: "pentagram-systematic",
    name: "Systematic Precision (Pentagram-inspired)",
    philosophyOrigin: "pentagram",
    prompt: `Approach this task with mathematical precision and grid-like structure.
- Use 8pt-multiple spacing/indentation throughout
- Apply extreme hierarchy in naming (top-level concept -> category -> instance)
- Minimize decoration: every comment, every variable name earns its place through clarity
- Information architecture is the primary expressive language
- Silence over noise: prefer absence to ornament
- Output reads like a typographic specification: regular rhythms, clean dividers, exact alignment`,
    category: "system",
    bestFor: [
      "technical-spec",
      "api-reference",
      "config-schema",
      "architectural-decision-record",
    ],
  },
  {
    id: "kenya-hara-emptiness",
    name: "Restraint & Whitespace (Kenya Hara-inspired)",
    philosophyOrigin: "kenya-hara",
    prompt: `Embrace 80%+ whitespace in your output.
- Subtract ruthlessly until only the essential remains
- Use subtle weight changes (bold/italic) where others would shout
- Each element must earn its presence; if removing it doesn't degrade meaning, remove it
- Empty space is not waste; it is composition
- Words breathe; sentences end early
- The reader hears the silence between paragraphs`,
    category: "minimalism",
    bestFor: [
      "readme",
      "philosophy-document",
      "design-rationale",
      "long-form-essay",
    ],
  },
  {
    id: "sagmeister-warm-minimal",
    name: "Joyful Minimalism (Sagmeister-inspired)",
    philosophyOrigin: "sagmeister-walsh",
    prompt: `Combine handcrafted warmth with digital precision.
- Use a minimal palette but emotionally rich language
- One unexpected metaphor or playful turn of phrase per major section
- Optimistic visual rhythm: short paragraphs, generous breaks, surprise reveals
- Technical accuracy without coldness; show the human behind the code
- Make the reader smile at least once`,
    category: "minimalism",
    bestFor: [
      "product-launch",
      "tutorial",
      "blog-post",
      "user-facing-error-message",
    ],
  },
  {
    id: "field-io-generative",
    name: "Procedural & Parametric (Field.io-inspired)",
    philosophyOrigin: "field.io",
    prompt: `Procedural over fixed. Embrace algorithmic variety, reject template uniformity.
- Express logic as parameters and rules, not concrete instances
- Where most code uses if-else, propose a single rule with parameters
- Every fixed value should have a reason for being unparameterized
- Mathematical formalism over narrative explanation
- Output should generalize: a single function over a family of solutions
- Comments describe the rule, not the case`,
    category: "generative",
    bestFor: [
      "algorithm-design",
      "data-pipeline",
      "config-DSL",
      "math-heavy-module",
    ],
  },
  {
    id: "takram-diagrammatic",
    name: "Diagram-First (Takram-inspired)",
    philosophyOrigin: "takram",
    prompt: `Diagrams are the primary communication. Prose is annotation.
- Lead every section with an ASCII diagram, flow chart, or relationship table
- Soft technological aesthetic: warm precision, not cold rigidity
- Use parentheticals to embed structure (input -> transform -> output)
- Restraint over verbosity: show the relationships, hide the procedure
- Reader should grasp the model in 5 seconds before reading details`,
    category: "diagrammatic",
    bestFor: [
      "architecture-doc",
      "system-design",
      "data-flow",
      "state-machine-spec",
    ],
  },
];

/** Look up a fixture by its id. */
export function getFixtureById(
  id: string,
): DesignPhilosophyFixture | undefined {
  return DESIGN_PHILOSOPHY_FIXTURES.find((f) => f.id === id);
}

/** Filter fixtures by category. */
export function getFixturesByCategory(
  category: DesignPhilosophyFixture["category"],
): DesignPhilosophyFixture[] {
  return DESIGN_PHILOSOPHY_FIXTURES.filter((f) => f.category === category);
}

/** Return all fixtures (defensive copy). */
export function listAllFixtures(): DesignPhilosophyFixture[] {
  return DESIGN_PHILOSOPHY_FIXTURES.slice();
}

/**
 * Register all design philosophy fixtures as a single experiment named
 * "design-philosophy". Returns the experiment name (which is also the file id).
 *
 * Caller is responsible for invoking this explicitly. Not auto-registered at
 * startup to avoid sub-agent side effects.
 */
export function registerDesignPhilosophyExperiment(rootDir?: string): string {
  registerExperiment({
    name: "design-philosophy",
    variants: DESIGN_PHILOSOPHY_FIXTURES.map((f) => ({
      id: f.id,
      content: f.prompt,
    })),
    rootDir,
  });
  return "design-philosophy";
}
