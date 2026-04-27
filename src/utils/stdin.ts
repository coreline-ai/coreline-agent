/**
 * Stdin utilities — read piped input if available.
 */

const STDIN_TIMEOUT = parseInt(process.env.CORELINE_STDIN_TIMEOUT ?? "10000", 10);

export function mergePromptAndStdin(
  prompt: string | undefined,
  stdinData: string | null | undefined,
): string | undefined {
  const trimmedPrompt = prompt?.trim();
  const trimmedStdin = stdinData?.trim();

  if (trimmedPrompt && trimmedStdin) {
    return `${trimmedPrompt}\n\n[stdin]\n${trimmedStdin}`;
  }

  return trimmedPrompt ?? trimmedStdin ?? undefined;
}

export async function readStdinIfPiped(): Promise<string | null> {
  if (process.stdin.isTTY) return null;

  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf-8");

    const onData = (chunk: string) => { data += chunk; };
    const onEnd = () => { cleanup(); resolve(data || null); };
    const onError = () => { cleanup(); resolve(null); };

    const timeout = setTimeout(() => {
      cleanup();
      resolve(data || null);
    }, STDIN_TIMEOUT);

    function cleanup() {
      clearTimeout(timeout);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
    }

    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
    process.stdin.resume();
  });
}
