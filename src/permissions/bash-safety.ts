/**
 * Lightweight bash safety helpers.
 *
 * This is intentionally a small, dependency-free scanner rather than a full
 * shell parser. It only recognizes the operators and command shapes needed by
 * the permission classifier, while respecting single/double quotes so quoted
 * metacharacters are not treated as shell control syntax.
 */

export type ShellToken =
  | { type: "word"; text: string; quoted: boolean }
  | { type: "operator"; text: string };

export interface BashSafetyWarning {
  code: string;
  message: string;
  matched: string;
}

const SAFE_REDIRECT_TARGETS = new Set(["/dev/null"]);

const DANGEROUS_PIPE_COMMANDS = new Set([
  "tee", "dd", "cp", "mv", "install", "scp", "rsync",
  "xargs", "parallel", "bash", "sh", "zsh", "fish", "ksh", "dash", "eval", "exec",
  "sudo", "su",
]);

const DB_CLIENT_COMMANDS = new Set([
  "psql", "mysql", "mariadb", "sqlite3", "duckdb", "sqlcmd",
]);

const SHELL_RC_FILES = [
  ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile",
  ".kshrc", ".cshrc", ".tcshrc", "config.fish", "/etc/profile",
];

const COMMAND_WRAPPERS = new Set([
  "sudo", "doas", "env", "command", "builtin", "noglob", "timeout", "gtimeout",
]);

const PRIVILEGED_COMMAND_WRAPPERS = new Set(["sudo", "doas"]);

const SHELL_COMMANDS = new Set(["bash", "sh", "zsh", "fish", "ksh", "dash", "csh", "tcsh"]);

const CODE_EVAL_COMMANDS = new Map<string, Set<string>>([
  ["python", new Set(["-c"])],
  ["python3", new Set(["-c"])],
  ["python2", new Set(["-c"])],
  ["node", new Set(["-e", "--eval", "-p", "--print"])],
  ["deno", new Set(["eval"])],
  ["bun", new Set(["-e", "--eval"])],
  ["perl", new Set(["-e", "-E"])],
  ["ruby", new Set(["-e"])],
  ["php", new Set(["-r"])],
  ["lua", new Set(["-e"])],
]);

const FILESYSTEM_MUTATION_COMMANDS = new Set([
  "chmod", "chown", "chgrp", "chattr", "setfacl",
]);

const ARCHIVE_EXTRACT_COMMANDS = new Set(["tar", "bsdtar", "gtar", "unzip", "7z", "7za", "7zr"]);

// ---------------------------------------------------------------------------
// Shell scanning/tokenization
// ---------------------------------------------------------------------------

function isWhitespace(char: string): boolean {
  return /\s/.test(char);
}

function isAllDigits(value: string): boolean {
  return /^\d+$/.test(value);
}

function isWriteRedirectOperator(operator: string): boolean {
  return (
    operator === ">" ||
    operator === ">>" ||
    operator === ">|" ||
    operator === "&>" ||
    operator === "&>>" ||
    operator === "<>" ||
    /^\d+>{1,2}$/.test(operator) ||
    /^\d+>\|$/.test(operator) ||
    /^\d+<>$/.test(operator)
  );
}

function quoteShellWord(word: string): string {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

function segmentToCommand(segment: ShellToken[]): string {
  return segment
    .map((token) => {
      if (token.type === "operator") return token.text;
      return token.quoted ? quoteShellWord(token.text) : token.text;
    })
    .join(" ")
    .trim();
}

function shellWords(segment: ShellToken[]): Array<Extract<ShellToken, { type: "word" }>> {
  return segment.filter((token): token is Extract<ShellToken, { type: "word" }> => token.type === "word");
}

function splitTokensOnOperators(tokens: ShellToken[], operators: Set<string>): ShellToken[][] {
  const segments: ShellToken[][] = [[]];

  for (const token of tokens) {
    if (token.type === "operator" && operators.has(token.text)) {
      if (segments[segments.length - 1]!.length > 0) {
        segments.push([]);
      }
      continue;
    }

    segments[segments.length - 1]!.push(token);
  }

  return segments.filter((segment) => segment.length > 0);
}

/** Tokenize a command while ignoring metacharacters inside single/double quotes. */
export function tokenizeShell(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let currentQuoted = false;
  let quote: "single" | "double" | null = null;

  const flushWord = () => {
    if (!current) return;
    tokens.push({ type: "word", text: current, quoted: currentQuoted });
    current = "";
    currentQuoted = false;
  };

  const pushOperator = (operator: string) => {
    flushWord();
    tokens.push({ type: "operator", text: operator });
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    const next = command[i + 1];

    if (quote === "single") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
        currentQuoted = true;
      }
      continue;
    }

    if (quote === "double") {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === "\\" && next !== undefined) {
        current += next;
        currentQuoted = true;
        i += 1;
        continue;
      }
      current += char;
      currentQuoted = true;
      continue;
    }

    if (char === "'") {
      quote = "single";
      currentQuoted = true;
      continue;
    }

    if (char === '"') {
      quote = "double";
      currentQuoted = true;
      continue;
    }

    if (char === "\\" && (next === "\n" || next === "\r")) {
      if (next === "\r" && command[i + 2] === "\n") {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }

    if (char === "\\" && next !== undefined) {
      current += next;
      i += 1;
      continue;
    }

    if (char === "\n" || char === "\r") {
      if (char === "\r" && next === "\n") i += 1;
      pushOperator(";");
      continue;
    }

    if (isWhitespace(char)) {
      flushWord();
      continue;
    }

    if (char === ";") {
      pushOperator(";");
      continue;
    }

    if (char === "|") {
      if (next === "|") {
        pushOperator("||");
        i += 1;
      } else {
        pushOperator("|");
      }
      continue;
    }

    if (char === "&") {
      if (next === "&") {
        pushOperator("&&");
        i += 1;
        continue;
      }
      if (next === ">") {
        const third = command[i + 2];
        pushOperator(third === ">" ? "&>>" : "&>");
        i += third === ">" ? 2 : 1;
        continue;
      }
      pushOperator("&");
      continue;
    }

    if (char === ">") {
      let prefix = "";
      if (!currentQuoted && isAllDigits(current)) {
        prefix = current;
        current = "";
      }

      let operator = `${prefix}>`;
      if (next === ">") {
        operator += ">";
        i += 1;
      } else if (next === "|") {
        operator += "|";
        i += 1;
      }
      pushOperator(operator);
      continue;
    }

    if (char === "<") {
      let prefix = "";
      if (!currentQuoted && isAllDigits(current)) {
        prefix = current;
        current = "";
      }

      let operator = `${prefix}<`;
      if (next === "<") {
        const third = command[i + 2];
        if (third === "<") {
          operator += "<<";
          i += 2;
        } else if (third === "-") {
          operator += "<-";
          i += 2;
        } else {
          operator += "<";
          i += 1;
        }
      } else if (next === ">") {
        operator += ">";
        i += 1;
      }
      pushOperator(operator);
      continue;
    }

    current += char;
  }

  flushWord();
  return tokens;
}

/** Split a command on unquoted shell command separators, excluding pipes. */
export function splitShellCommandList(command: string): string[] {
  const tokens = tokenizeShell(command);
  return splitTokensOnOperators(tokens, new Set([";", "&&", "||", "&"]))
    .map(segmentToCommand)
    .filter(Boolean);
}

/** Split a command on unquoted pipe operators only. */
export function splitShellPipeline(command: string): string[] {
  const tokens = tokenizeShell(command);
  return splitTokensOnOperators(tokens, new Set(["|"]))
    .map(segmentToCommand)
    .filter(Boolean);
}

export interface EffectiveShellCommand {
  words: string[];
  wrappers: string[];
  privileged: boolean;
}

function toLowerWords(words: string[]): string[] {
  return words.map((word) => word.toLowerCase());
}

function isLongOptionWithInlineValue(word: string, option: string): boolean {
  return word.startsWith(`${option}=`);
}

function skipOptionValue(words: string[], index: number, optionsWithValues: Set<string>): number {
  const word = words[index]!;
  const lower = word.toLowerCase();

  if (word === "--") return index + 1;

  if (optionsWithValues.has(lower)) {
    return Math.min(index + 2, words.length);
  }

  for (const option of optionsWithValues) {
    if (option.startsWith("--") && isLongOptionWithInlineValue(lower, option)) {
      return index + 1;
    }
  }

  return index + 1;
}

function skipSudoOptions(words: string[], startIndex: number): number {
  const optionsWithValues = new Set([
    "-C", "-g", "-h", "-p", "-R", "-r", "-t", "-U", "-u",
    "--askpass", "--chdir", "--close-from", "--group", "--host",
    "--prompt", "--role", "--type", "--user",
  ].map((word) => word.toLowerCase()));

  let index = startIndex;
  while (index < words.length) {
    const word = words[index]!;
    if (word === "--") return index + 1;
    if (!word.startsWith("-") || word === "-") break;
    index = skipOptionValue(words, index, optionsWithValues);
  }

  return index;
}

function skipEnvOptions(words: string[], startIndex: number): number {
  const optionsWithValues = new Set([
    "-C", "-S", "-u", "--block-signal", "--chdir", "--default-signal",
    "--ignore-signal", "--split-string", "--unset",
  ].map((word) => word.toLowerCase()));

  let index = startIndex;
  while (index < words.length) {
    const word = words[index]!;
    const lower = word.toLowerCase();

    if (word === "--") {
      index += 1;
      break;
    }

    if (looksLikeEnvAssignment(word)) {
      index += 1;
      continue;
    }

    if (word === "-" || lower === "-i" || lower === "--ignore-environment" || lower === "-0" || lower === "--null") {
      index += 1;
      continue;
    }

    if (word.startsWith("-")) {
      index = skipOptionValue(words, index, optionsWithValues);
      continue;
    }

    break;
  }

  return index;
}

function looksLikeTimeoutDuration(word: string): boolean {
  return /^\d+(?:\.\d+)?(?:[smhd]|\w+)?$/i.test(word);
}

function skipTimeoutPrefix(words: string[], startIndex: number): number {
  const optionsWithValues = new Set([
    "-k", "-s", "--kill-after", "--signal",
  ].map((word) => word.toLowerCase()));

  let index = startIndex;
  while (index < words.length) {
    const word = words[index]!;
    const lower = word.toLowerCase();

    if (word === "--") {
      index += 1;
      break;
    }

    if (!word.startsWith("-") || word === "-") break;

    if (
      lower === "--foreground" ||
      lower === "--preserve-status" ||
      lower === "-v" ||
      lower === "--verbose"
    ) {
      index += 1;
      continue;
    }

    index = skipOptionValue(words, index, optionsWithValues);
  }

  if (index < words.length && looksLikeTimeoutDuration(words[index]!)) {
    index += 1;
  }

  return index;
}

function shouldTreatCommandAsWrapper(words: string[], index: number): boolean {
  const next = words[index + 1];
  if (!next) return false;
  if (next === "-v" || next === "-V") return false;
  return true;
}

/** Strip env assignments and lightweight wrapper commands to reveal the command being classified. */
export function getEffectiveShellCommand(words: string[]): EffectiveShellCommand {
  let index = 0;
  const wrappers: string[] = [];
  let privileged = false;

  while (index < words.length) {
    const word = words[index]!;
    const lower = word.toLowerCase();

    if (looksLikeEnvAssignment(word)) {
      index += 1;
      continue;
    }

    if (!COMMAND_WRAPPERS.has(lower)) break;

    if ((lower === "sudo" || lower === "doas")) {
      wrappers.push(word);
      privileged = true;
      index = skipSudoOptions(words, index + 1);
      continue;
    }

    if (lower === "env") {
      wrappers.push(word);
      index = skipEnvOptions(words, index + 1);
      continue;
    }

    if (lower === "timeout" || lower === "gtimeout") {
      wrappers.push(word);
      index = skipTimeoutPrefix(words, index + 1);
      continue;
    }

    if (lower === "command") {
      if (!shouldTreatCommandAsWrapper(words, index)) break;
      wrappers.push(word);
      index += 1;
      while (index < words.length && ["-p", "--"].includes(words[index]!)) {
        index += 1;
      }
      continue;
    }

    wrappers.push(word);
    index += 1;
  }

  return { words: words.slice(index), wrappers, privileged };
}

// ---------------------------------------------------------------------------
// High-risk shell constructs
// ---------------------------------------------------------------------------

function findShellExpansion(command: string): BashSafetyWarning | null {
  let quote: "single" | "double" | null = null;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]!;
    const next = command[i + 1];

    if (quote === "single") {
      if (char === "'") quote = null;
      continue;
    }

    if (char === "\\" && next !== undefined) {
      i += 1;
      continue;
    }

    if (quote === "double") {
      if (char === '"') {
        quote = null;
        continue;
      }
      if (char === "$" && next === "(") {
        return {
          code: "command-substitution",
          message: "Command substitution executes nested shell code",
          matched: "$(...)",
        };
      }
      if (char === "`") {
        return {
          code: "command-substitution",
          message: "Backtick command substitution executes nested shell code",
          matched: "`...`",
        };
      }
      continue;
    }

    if (char === "'") {
      quote = "single";
      continue;
    }

    if (char === '"') {
      quote = "double";
      continue;
    }

    if (char === "$" && next === "(") {
      return {
        code: "command-substitution",
        message: "Command substitution executes nested shell code",
        matched: "$(...)",
      };
    }

    if (char === "`") {
      return {
        code: "command-substitution",
        message: "Backtick command substitution executes nested shell code",
        matched: "`...`",
      };
    }

    if ((char === "<" || char === ">") && next === "(") {
      return {
        code: "process-substitution",
        message: "Process substitution executes nested shell code",
        matched: `${char}(...)`,
      };
    }
  }

  return null;
}

function looksLikeShellRc(path: string): boolean {
  return SHELL_RC_FILES.some((rcFile) => path === rcFile || path.endsWith(`/${rcFile}`));
}

function isHereDocOperator(operator: string): boolean {
  return /^(\d+)?<<-?$/.test(operator) || /^(\d+)?<<<$/.test(operator);
}

function getHereDocWarning(command: string): BashSafetyWarning | null {
  const operator = tokenizeShell(command).find((token) => token.type === "operator" && isHereDocOperator(token.text));
  if (operator?.type !== "operator") return null;

  return {
    code: operator.text.endsWith("<<<") ? "here-string" : "heredoc",
    message: "Here-doc/here-string input can hide multi-line shell content; review before execution",
    matched: operator.text,
  };
}

function commandWordsFromSegment(segment: ShellToken[]): string[] {
  return getEffectiveShellCommand(shellWords(segment).map((word) => word.text)).words;
}

function hasShellCodeOption(words: string[]): boolean {
  const first = words[0]?.toLowerCase();
  if (!first || !SHELL_COMMANDS.has(first)) return false;

  return words.slice(1).some((word) => {
    if (!word.startsWith("-") || word === "--") return false;
    if (word === "-c") return true;
    return /^-[A-Za-z]*c[A-Za-z]*$/.test(word);
  });
}

function getCodeExecutionWarning(words: string[]): BashSafetyWarning | null {
  const first = words[0]?.toLowerCase();
  if (!first) return null;

  if (hasShellCodeOption(words)) {
    return {
      code: "shell-c",
      message: `${first} -c executes inline shell code`,
      matched: `${first} -c`,
    };
  }

  const evalOptions = CODE_EVAL_COMMANDS.get(first);
  if (!evalOptions) return null;

  const matched = words.slice(1).find((word) => evalOptions.has(word));
  if (!matched) return null;

  return {
    code: "inline-code",
    message: `${first} ${matched} executes inline code`,
    matched: `${first} ${matched}`,
  };
}

function isDownloaderCommand(words: string[]): boolean {
  const first = words[0]?.toLowerCase();
  return first === "curl" || first === "wget" || first === "fetch";
}

function getRemotePipeWarning(command: string): BashSafetyWarning | null {
  const pipelineSegments = splitShellPipeline(command);
  if (pipelineSegments.length <= 1) return null;

  for (let index = 0; index < pipelineSegments.length - 1; index += 1) {
    const sourceWords = getEffectiveShellCommand(
      tokenizeShell(pipelineSegments[index]!)
        .filter((token): token is Extract<ShellToken, { type: "word" }> => token.type === "word")
        .map((token) => token.text),
    ).words;
    const targetWords = getEffectiveShellCommand(
      tokenizeShell(pipelineSegments[index + 1]!)
        .filter((token): token is Extract<ShellToken, { type: "word" }> => token.type === "word")
        .map((token) => token.text),
    ).words;
    const target = targetWords[0]?.toLowerCase();

    if (isDownloaderCommand(sourceWords) && target && SHELL_COMMANDS.has(target)) {
      return {
        code: "remote-script-pipe",
        message: "Remote downloader output piped into a shell executes untrusted code",
        matched: `${sourceWords[0]} | ${targetWords[0]}`,
      };
    }
  }

  return null;
}

export function getHighRiskShellWarning(command: string): BashSafetyWarning | null {
  const expansionWarning = findShellExpansion(command);
  if (expansionWarning) return expansionWarning;

  const hereDocWarning = getHereDocWarning(command);
  if (hereDocWarning) return hereDocWarning;

  const remotePipeWarning = getRemotePipeWarning(command);
  if (remotePipeWarning) return remotePipeWarning;

  const tokens = tokenizeShell(command);
  const commandSegments = splitTokensOnOperators(tokens, new Set([";", "&&", "||", "&", "|"]));

  for (const segment of commandSegments) {
    const words = commandWordsFromSegment(segment);
    const first = words[0]?.toLowerCase();
    if (!first) continue;
    const lower = toLowerWords(words);

    const codeExecutionWarning = getCodeExecutionWarning(words);
    if (codeExecutionWarning) return codeExecutionWarning;

    if (first === "find" && lower.some((word) => word === "-exec" || word === "-execdir")) {
      return {
        code: "find-exec",
        message: "find -exec executes a nested command for each matched path",
        matched: "find -exec",
      };
    }

    if (first === "xargs" && getXargsCommandWords(words).length > 0) {
      return {
        code: "xargs-exec",
        message: "xargs executes commands assembled from stdin",
        matched: words.join(" "),
      };
    }

    if (first === "parallel" && getParallelCommandWords(words).length > 0) {
      return {
        code: "parallel-exec",
        message: "parallel executes command templates across input arguments",
        matched: words.join(" "),
      };
    }

    if (first === "eval") {
      return { code: "eval", message: "eval executes dynamically constructed shell code", matched: first };
    }

    if (first === "exec") {
      return { code: "exec", message: "exec replaces the current shell with another command", matched: first };
    }

    if (first === "source" || first === ".") {
      return { code: "source", message: "source executes commands from another file", matched: first };
    }

    if (SHELL_COMMANDS.has(first)) {
      const rcTarget = words.slice(1).find((word) => looksLikeShellRc(word));
      if (rcTarget) {
        return {
          code: "shell-rc",
          message: "Executing shell rc files can run arbitrary startup code",
          matched: rcTarget,
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Destructive command warnings
// ---------------------------------------------------------------------------

function hasRmRecursiveOrForce(words: string[]): boolean {
  return words.some((word) => {
    if (word === "--recursive" || word === "--force") return true;
    return /^-[A-Za-z]+$/.test(word) && (word.includes("r") || word.includes("R") || word.includes("f"));
  });
}

function looksLikeEnvAssignment(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

function stripCommandWrappers(words: string[]): string[] {
  return getEffectiveShellCommand(words).words;
}

function skipNestedCommandOptions(words: string[], startIndex: number, optionsWithValues: Set<string>): number {
  let index = startIndex;

  while (index < words.length) {
    const word = words[index]!;
    const lower = word.toLowerCase();

    if (word === "--") return index + 1;
    if (!word.startsWith("-") || word === "-") break;

    index = skipOptionValue(words, index, optionsWithValues);

    // GNU xargs/parallel allow compact options like -I{} where the value is in
    // the same token. `skipOptionValue` already advances by one for these.
    if (/^-[IPSEJjLn]\S+/.test(word) || /^--[^=]+=/.test(lower)) {
      continue;
    }
  }

  return index;
}

function getXargsCommandWords(words: string[]): string[] {
  const optionsWithValues = new Set([
    "-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "-x",
    "--arg-file", "--delimiter", "--eof", "--max-args", "--max-chars",
    "--max-lines", "--max-procs", "--process-slot-var", "--replace",
  ].map((word) => word.toLowerCase()));
  const index = skipNestedCommandOptions(words, 1, optionsWithValues);
  return words.slice(index);
}

function getParallelCommandWords(words: string[]): string[] {
  const optionsWithValues = new Set([
    "-a", "-j", "-N", "-S", "--arg-file", "--jobs", "--sshlogin", "--sshloginfile",
    "--results", "--joblog", "--timeout", "--delay", "--colsep",
  ].map((word) => word.toLowerCase()));
  const index = skipNestedCommandOptions(words, 1, optionsWithValues);
  return words.slice(index);
}

function getFindExecCommandWords(words: string[]): string[] {
  const lower = toLowerWords(words);
  const execIndex = lower.findIndex((word) => word === "-exec" || word === "-execdir");
  if (execIndex === -1) return [];

  const nested: string[] = [];
  for (const word of words.slice(execIndex + 1)) {
    if (word === ";" || word === "+" || word === "\\;") break;
    nested.push(word);
  }
  return nested;
}

function hasDestructiveSql(words: string[]): boolean {
  const first = words[0]?.toUpperCase();
  const hasDbClient = first !== undefined && DB_CLIENT_COMMANDS.has(first.toLowerCase());
  const startsWithSqlVerb = first === "DROP" || first === "TRUNCATE" || first === "DELETE";

  if (!hasDbClient && !startsWithSqlVerb) return false;

  const normalized = words.join(" ").replace(/\s+/g, " ").toUpperCase();
  return /\bDROP\b/.test(normalized)
    || /\bTRUNCATE\b/.test(normalized)
    || /\bDELETE\s+FROM\b/.test(normalized);
}

function gitWarning(words: string[]): BashSafetyWarning | null {
  const subcommand = words[1]?.toLowerCase();
  const rest = words.slice(2);
  const restLower = rest.map((word) => word.toLowerCase());

  if (subcommand === "reset" && restLower.includes("--hard")) {
    return { code: "git-reset-hard", message: "git reset --hard discards working tree changes", matched: "git reset --hard" };
  }

  if (subcommand === "push") {
    const forceFlag = restLower.find((word) => (
      word === "--force" ||
      word.startsWith("--force-with-lease") ||
      word === "-f" ||
      /^-[A-Za-z]*f[A-Za-z]*$/.test(word)
    ));
    if (forceFlag) {
      return { code: "git-push-force", message: "git push force flags rewrite remote history", matched: forceFlag };
    }
  }

  if (subcommand === "clean") {
    const forceFlag = restLower.find((word) => word === "--force" || /^-[A-Za-z]*f[A-Za-z]*$/.test(word));
    if (forceFlag) {
      return { code: "git-clean-force", message: "git clean -f removes untracked files", matched: forceFlag };
    }
  }

  if ((subcommand === "checkout" || subcommand === "restore") && rest.includes(".")) {
    return { code: `git-${subcommand}-dot`, message: `git ${subcommand} . can overwrite working tree changes`, matched: `git ${subcommand} .` };
  }

  if (subcommand === "stash" && restLower.some((word) => word === "drop" || word === "clear")) {
    return { code: "git-stash-drop", message: "git stash drop/clear deletes saved work", matched: `git stash ${restLower.find((word) => word === "drop" || word === "clear")}` };
  }

  if (subcommand === "branch" && rest.includes("-D")) {
    return { code: "git-branch-delete-force", message: "git branch -D force-deletes a branch", matched: "git branch -D" };
  }

  if (subcommand === "commit" && restLower.includes("--amend")) {
    return { code: "git-commit-amend", message: "git commit --amend rewrites the last commit", matched: "git commit --amend" };
  }

  return null;
}

function getDestructiveWarningForWords(words: string[]): BashSafetyWarning | null {
  const lowerWords = toLowerWords(words);
  const first = lowerWords[0];
  if (!first) return null;

  if (first === "git") {
    const noVerify = lowerWords.find((word) => word === "--no-verify");
    if (noVerify) {
      return { code: "no-verify", message: "--no-verify bypasses configured safety checks", matched: noVerify };
    }

    const warning = gitWarning(words);
    if (warning) return warning;
  }

  if (first === "rm" && hasRmRecursiveOrForce(words)) {
    return { code: "rm-recursive-force", message: "rm recursive/force flags can delete files irreversibly", matched: words.join(" ") };
  }

  if (hasDestructiveSql(words)) {
    return { code: "db-destructive-sql", message: "Destructive SQL detected (DROP/TRUNCATE/DELETE FROM)", matched: words.join(" ") };
  }

  if (first === "kubectl" && lowerWords.slice(1).includes("delete")) {
    return { code: "kubectl-delete", message: "kubectl delete removes Kubernetes resources", matched: "kubectl delete" };
  }

  if (first === "terraform" && lowerWords.slice(1).includes("destroy")) {
    return { code: "terraform-destroy", message: "terraform destroy tears down managed infrastructure", matched: "terraform destroy" };
  }

  return null;
}

/** Return a warning for known destructive commands, if this command contains one. */
export function getDestructiveCommandWarning(command: string): BashSafetyWarning | null {
  const tokens = tokenizeShell(command);
  const commandSegments = splitTokensOnOperators(tokens, new Set([";", "&&", "||", "&", "|"]));

  for (const segment of commandSegments) {
    const rawWords = shellWords(segment).map((word) => word.text);
    const words = stripCommandWrappers(rawWords);
    const lower = toLowerWords(words);
    const first = lower[0];
    if (!first) continue;

    const directWarning = getDestructiveWarningForWords(words);
    if (directWarning) return directWarning;

    if (first === "find") {
      if (lower.includes("-delete")) {
        return { code: "find-delete", message: "find -delete removes matched files", matched: "find -delete" };
      }

      const nestedWords = getFindExecCommandWords(words);
      const nestedWarning = getDestructiveWarningForWords(stripCommandWrappers(nestedWords));
      if (nestedWarning) {
        return {
          code: "find-exec-destructive",
          message: `find -exec runs a destructive nested command: ${nestedWarning.message}`,
          matched: nestedWords.join(" "),
        };
      }
    }

    if (first === "xargs") {
      const nestedWords = getXargsCommandWords(words);
      const nestedWarning = getDestructiveWarningForWords(stripCommandWrappers(nestedWords));
      if (nestedWarning) {
        return {
          code: "xargs-destructive",
          message: `xargs runs a destructive nested command: ${nestedWarning.message}`,
          matched: nestedWords.join(" "),
        };
      }
    }

    if (first === "parallel") {
      const nestedWords = getParallelCommandWords(words);
      const nestedWarning = getDestructiveWarningForWords(stripCommandWrappers(nestedWords));
      if (nestedWarning) {
        return {
          code: "parallel-destructive",
          message: `parallel runs a destructive nested command: ${nestedWarning.message}`,
          matched: nestedWords.join(" "),
        };
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Other ask-level command warnings
// ---------------------------------------------------------------------------

export function getPrivilegedWrapperWarning(command: string): BashSafetyWarning | null {
  const tokens = tokenizeShell(command);
  const commandSegments = splitTokensOnOperators(tokens, new Set([";", "&&", "||", "&", "|"]));

  for (const segment of commandSegments) {
    const effective = getEffectiveShellCommand(shellWords(segment).map((word) => word.text));
    const privilegedWrapper = effective.wrappers.find((wrapper) => (
      PRIVILEGED_COMMAND_WRAPPERS.has(wrapper.toLowerCase())
    ));

    if (effective.privileged && privilegedWrapper) {
      return {
        code: "privileged-wrapper",
        message: `${privilegedWrapper} runs commands with elevated privileges`,
        matched: privilegedWrapper,
      };
    }
  }

  return null;
}

function optionListHasShortFlag(words: string[], flag: string): boolean {
  return words.some((word) => {
    if (!word.startsWith("-") || word.startsWith("--")) return false;
    return word.slice(1).includes(flag);
  });
}

function isArchiveExtract(words: string[]): boolean {
  const first = words[0]?.toLowerCase();
  if (!first || !ARCHIVE_EXTRACT_COMMANDS.has(first)) return false;
  const lower = toLowerWords(words);

  if (first === "tar" || first === "bsdtar" || first === "gtar") {
    return lower.some((word) => word === "--extract" || word === "-x") || optionListHasShortFlag(words, "x");
  }

  if (first === "unzip") {
    return !lower.some((word) => word === "-l" || word === "--list" || word === "-t");
  }

  if (first === "7z" || first === "7za" || first === "7zr") {
    return lower[1] === "x" || lower[1] === "e";
  }

  return false;
}

export function getFilesystemMutationWarning(command: string): BashSafetyWarning | null {
  const tokens = tokenizeShell(command);
  const commandSegments = splitTokensOnOperators(tokens, new Set([";", "&&", "||", "&", "|"]));

  for (const segment of commandSegments) {
    const words = commandWordsFromSegment(segment);
    const lower = toLowerWords(words);
    const first = lower[0];
    if (!first) continue;

    if (FILESYSTEM_MUTATION_COMMANDS.has(first)) {
      return {
        code: "filesystem-metadata-mutation",
        message: `${first} changes filesystem ownership, mode, attributes, or ACLs`,
        matched: words.join(" "),
      };
    }

    if (first === "ln" && lower.some((word) => word === "-s" || word === "--symbolic" || /^-[A-Za-z]*s[A-Za-z]*$/.test(word))) {
      return {
        code: "symlink-creation",
        message: "ln -s creates or replaces symbolic links",
        matched: words.join(" "),
      };
    }

    if (isArchiveExtract(words)) {
      return {
        code: "archive-extract",
        message: `${first} extraction writes files and may overwrite existing paths`,
        matched: words.join(" "),
      };
    }
  }

  return null;
}

const SAFE_PACKAGE_SCRIPTS = new Set(["build", "lint", "format", "typecheck", "check", "test"]);

function nextNonOption(words: string[], startIndex: number): { word: string | undefined; index: number } {
  let index = startIndex;
  while (index < words.length) {
    const word = words[index]!;
    if (word === "--") {
      index += 1;
      break;
    }
    if (!word.startsWith("-")) break;
    index += 1;
  }

  return { word: words[index], index };
}

function isSafePackageScript(words: string[]): boolean {
  const first = words[0]?.toLowerCase();
  if (!first) return false;
  const { word: subcommand, index: subcommandIndex } = nextNonOption(words, 1);
  const sub = subcommand?.toLowerCase();

  if (!sub) return false;

  if (first === "npm") {
    if (sub === "test" || sub === "t") return true;
    if (sub === "run" || sub === "run-script") {
      const { word: script } = nextNonOption(words, subcommandIndex + 1);
      return script !== undefined && SAFE_PACKAGE_SCRIPTS.has(script.toLowerCase());
    }
    return SAFE_PACKAGE_SCRIPTS.has(sub);
  }

  if (first === "bun") {
    if (sub === "test") return true;
    if (sub === "run") {
      const { word: script } = nextNonOption(words, subcommandIndex + 1);
      return script !== undefined && SAFE_PACKAGE_SCRIPTS.has(script.toLowerCase());
    }
    return SAFE_PACKAGE_SCRIPTS.has(sub);
  }

  if (first === "yarn" || first === "pnpm") {
    if (sub === "test") return true;
    if (sub === "run") {
      const { word: script } = nextNonOption(words, subcommandIndex + 1);
      return script !== undefined && SAFE_PACKAGE_SCRIPTS.has(script.toLowerCase());
    }
    return SAFE_PACKAGE_SCRIPTS.has(sub);
  }

  return false;
}

export function getPackageManagerScriptWarning(command: string): BashSafetyWarning | null {
  const tokens = tokenizeShell(command);
  const commandSegments = splitTokensOnOperators(tokens, new Set([";", "&&", "||", "&", "|"]));

  for (const segment of commandSegments) {
    const words = commandWordsFromSegment(segment);
    const first = words[0]?.toLowerCase();
    if (!first) continue;

    if (first === "npx" || first === "bunx") {
      return {
        code: "package-binary-exec",
        message: `${first} executes a package-provided binary`,
        matched: words.join(" "),
      };
    }

    if (!["npm", "yarn", "pnpm", "bun"].includes(first)) continue;
    if (isSafePackageScript(words)) continue;

    const { word: subcommand } = nextNonOption(words, 1);
    const sub = subcommand?.toLowerCase();
    if (!sub) continue;

    if (
      sub === "run" ||
      sub === "run-script" ||
      sub === "start" ||
      sub === "dev" ||
      sub === "exec" ||
      sub === "x" ||
      sub === "dlx" ||
      sub === "create"
    ) {
      return {
        code: "package-script-exec",
        message: `${first} ${sub} can execute arbitrary project or package scripts`,
        matched: words.join(" "),
      };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Redirects and pipe targets
// ---------------------------------------------------------------------------

/** Check if command contains write redirects, excluding redirects to /dev/null. */
export function hasUnsafeRedirect(command: string): boolean {
  const tokens = tokenizeShell(command);

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.type !== "operator" || !isWriteRedirectOperator(token.text)) continue;

    const target = tokens.slice(index + 1).find((candidate) => candidate.type === "word");
    if (!target || target.type !== "word") return true;
    if (!SAFE_REDIRECT_TARGETS.has(target.text)) return true;
  }

  return false;
}

/** Check if any unquoted pipe feeds into a write-capable/downstream shell command. */
export function hasDangerousPipeTarget(command: string): boolean {
  const segments = splitShellPipeline(command);
  if (segments.length <= 1) return false;

  for (const segment of segments.slice(1)) {
    const words = getEffectiveShellCommand(
      tokenizeShell(segment)
        .filter((token): token is Extract<ShellToken, { type: "word" }> => token.type === "word")
        .map((token) => token.text),
    ).words;
    const firstWord = words[0]?.toLowerCase();
    if (firstWord && DANGEROUS_PIPE_COMMANDS.has(firstWord)) {
      return true;
    }
  }

  return false;
}
