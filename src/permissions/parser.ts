/**
 * Permission rule expression parser.
 *
 * Supports expressions like:
 * - Bash(git *)
 * - FileRead(src/path/*.ts)
 *
 * Returns null for malformed input.
 */

export interface ParsedRuleExpression {
  toolName: string;
  pattern?: string;
}

export function parseRuleExpression(expression: string): ParsedRuleExpression | null {
  const trimmed = expression.trim();
  if (!trimmed) {
    return null;
  }

  const openIndex = trimmed.indexOf("(");
  const closeIndex = trimmed.lastIndexOf(")");

  if (openIndex <= 0 || closeIndex !== trimmed.length - 1 || closeIndex < openIndex) {
    return null;
  }

  const toolName = trimmed.slice(0, openIndex).trim();
  if (!toolName || /\s/.test(toolName)) {
    return null;
  }

  const pattern = trimmed.slice(openIndex + 1, closeIndex).trim();
  return pattern ? { toolName, pattern } : { toolName };
}
