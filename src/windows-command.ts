import { execFile } from "node:child_process";

const commandTimeoutMs = 10_000;

export class WindowsCommandError extends Error {
  constructor(message: string, readonly exitCode: number | null) {
    super(message);
    this.name = "WindowsCommandError";
  }
}

export async function runWindowsCommand(
  executable: string,
  commandArguments: readonly string[],
  failureMessage: string,
  environment: Readonly<Record<string, string>> = {}
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      commandArguments,
      {
        env: { ...process.env, ...environment },
        timeout: commandTimeoutMs,
        windowsHide: true
      },
      (error, standardOutput, standardError): void => {
        if (error) {
          reject(new WindowsCommandError(
            commandErrorMessage(failureMessage, error, standardOutput, standardError),
            typeof error.code === "number" ? error.code : null
          ));
          return;
        }

        resolve(standardOutput);
      }
    );
  });
}

function commandErrorMessage(failureMessage: string, error: Error, standardOutput: string, standardError: string): string {
  const output = [standardError.trim(), standardOutput.trim()].filter(Boolean).join("\n");
  return `${failureMessage}\n${output || error.message}`;
}
