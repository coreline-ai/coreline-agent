import { describe, expect, test } from "bun:test";
import {
  detectSensitiveContent,
  detectSensitiveMemoryContent,
  getSecretLabel,
  redactSecrets,
  scanForSecrets,
} from "../src/memory/safety.js";

const githubPat = `ghp_${"a".repeat(36)}`;
const githubFineGrainedPat = `github_pat_${"b".repeat(82)}`;
const gitlabPat = `glpat-${"c".repeat(20)}`;
const openAiKey = `sk-proj-${"d".repeat(58)}T3BlbkFJ${"e".repeat(58)}`;
const anthropicKey = `sk-ant-api03-${"f".repeat(93)}AA`;
const slackBotToken = "xoxb-" + "123456789012-123456789012-abcdefABCDEF123456";
const npmToken = `npm_${"g".repeat(36)}`;
const awsAccessKey = "AKIAIOSFODNN7EXAMPLE";
const privateKey = `-----BEGIN PRIVATE KEY-----\n${"M".repeat(64)}\n-----END PRIVATE KEY-----`;

describe("memory secret scanner", () => {
  test("detects representative high-confidence secret patterns without returning values", () => {
    const cases = [
      { value: awsAccessKey, ruleId: "aws-access-token", label: "AWS access key" },
      { value: githubPat, ruleId: "github-pat", label: "GitHub personal access token" },
      {
        value: githubFineGrainedPat,
        ruleId: "github-fine-grained-pat",
        label: "GitHub fine-grained personal access token",
      },
      { value: gitlabPat, ruleId: "gitlab-pat", label: "GitLab personal access token" },
      { value: openAiKey, ruleId: "openai-api-key", label: "OpenAI API key" },
      { value: anthropicKey, ruleId: "anthropic-api-key", label: "Anthropic API key" },
      { value: slackBotToken, ruleId: "slack-bot-token", label: "Slack bot token" },
      { value: npmToken, ruleId: "npm-access-token", label: "npm access token" },
      { value: privateKey, ruleId: "private-key", label: "Private key" },
    ];

    for (const { value, ruleId, label } of cases) {
      const matches = scanForSecrets(`credential: ${value}`);

      expect(matches).toContainEqual({ ruleId, label });
      expect(detectSensitiveContent(`credential: ${value}`)).toBe(label);
      expect(JSON.stringify(matches)).not.toContain(value);
    }
  });

  test("keeps legacy generic assignment detection", () => {
    expect(detectSensitiveContent('password = "mysecret123"')).toBe("Password assignment");
    expect(detectSensitiveContent('secret: "shared-value"')).toBe("Secret assignment");
    expect(detectSensitiveContent('token = "not-a-provider-token"')).toBe("Token assignment");
  });

  test("prioritizes high-confidence labels over generic token assignment", () => {
    const content = `token = "${githubPat}"`;
    const matches = scanForSecrets(content);

    expect(matches[0]).toEqual({
      ruleId: "github-pat",
      label: "GitHub personal access token",
    });
    expect(matches.some((match) => match.ruleId === "legacy-token-assignment")).toBe(false);
    expect(detectSensitiveContent(content)).toBe("GitHub personal access token");
  });

  test("redacts secret values while preserving surrounding text", () => {
    const content = `openai=${openAiKey}\nnpm=${npmToken}\npassword = "mysecret123"`;
    const redacted = redactSecrets(content);

    expect(redacted).toContain("[REDACTED]");
    expect(redacted).toContain("openai=");
    expect(redacted).toContain("npm=");
    expect(redacted).toContain("password = ");
    expect(redacted).not.toContain(openAiKey);
    expect(redacted).not.toContain(npmToken);
    expect(redacted).not.toContain("mysecret123");
  });

  test("detects sensitive values across memory entry fields", () => {
    expect(detectSensitiveMemoryContent({ description: `Anthropic key: ${anthropicKey}` })).toBe(
      "Anthropic API key",
    );
    expect(detectSensitiveMemoryContent({ name: `bad_${awsAccessKey}` })).toBe("AWS access key");
    expect(detectSensitiveMemoryContent({ body: "한국어로 응답해주세요." })).toBeNull();
  });

  test("returns safe labels for known and unknown rule ids", () => {
    expect(getSecretLabel("openai-api-key")).toBe("OpenAI API key");
    expect(getSecretLabel("custom-secret-rule")).toBe("Custom Secret Rule");
  });
});
