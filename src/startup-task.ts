import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runWindowsCommand, WindowsCommandError } from "./windows-command";

const whoamiExecutable = String.raw`C:\Windows\System32\whoami.exe`;
const schtasksExecutable = String.raw`C:\Windows\System32\schtasks.exe`;
const startupTaskNamePrefix = "Softshot Startup";
const startupTaskDelay = "PT15S";
const normalStartupTaskPriority = 4;
const missingTaskExitCode = 1;
const highIntegrityLevel = 12_288;
const byteOrderMark = "\u{FEFF}";
const userSidPattern = /"(?<sid>S-1-5-[\d-]+)"/u;
const integrityLevelPattern = /"S-1-16-(?<level>\d+)"/u;
const xmlEscapes: Readonly<Record<string, string>> = {
  "\"": "&quot;",
  "&": "&amp;",
  "'": "&apos;",
  "<": "&lt;",
  ">": "&gt;"
};

export interface WindowsAccount {
  isElevated: boolean;
  sid: string;
}

export async function currentWindowsAccount(): Promise<WindowsAccount> {
  const output = await runWindowsCommand(
    whoamiExecutable,
    ["/user", "/groups", "/fo", "csv", "/nh"],
    "Could not read the Windows account."
  );
  const [userLine] = output.split(/\r?\n/u);
  const sid = userSidPattern.exec(userLine)?.groups?.sid;
  const integrityLevel = integrityLevelPattern.exec(output)?.groups?.level;
  if (!sid || !integrityLevel) {
    throw new Error(`Could not read the Windows account.\n${output.trim()}`);
  }

  return { isElevated: Number(integrityLevel) >= highIntegrityLevel, sid };
}

export async function syncElevatedStartupTask(account: WindowsAccount, executablePath: string, isEnabled: boolean): Promise<boolean> {
  const taskName = `${startupTaskNamePrefix}-${account.sid}`;
  if (account.isElevated && isEnabled) {
    await registerStartupTask(taskName, startupTaskXml(account.sid, executablePath));
    return true;
  }

  if (!await hasStartupTask(taskName)) {
    return false;
  }

  if (isEnabled) {
    return true;
  }

  await runWindowsCommand(
    schtasksExecutable,
    ["/Delete", "/TN", taskName, "/F"],
    account.isElevated
      ? "Could not remove the Softshot startup task."
      : "Softshot starts as administrator when you sign in. Run Softshot as administrator to turn off launch at startup."
  );
  return false;
}

async function registerStartupTask(taskName: string, taskXml: string): Promise<void> {
  const taskFilePath = path.join(os.tmpdir(), `softshot-startup-task-${randomUUID()}.xml`);
  await writeFile(taskFilePath, `${byteOrderMark}${taskXml}`, "utf16le");
  try {
    await runWindowsCommand(
      schtasksExecutable,
      ["/Create", "/TN", taskName, "/XML", taskFilePath, "/F"],
      "Could not create the Softshot startup task."
    );
  } finally {
    await rm(taskFilePath, { force: true });
  }
}

async function hasStartupTask(taskName: string): Promise<boolean> {
  try {
    await runWindowsCommand(schtasksExecutable, ["/Query", "/TN", taskName], "Could not check the Softshot startup task.");
    return true;
  } catch (error) {
    if (error instanceof WindowsCommandError && error.exitCode === missingTaskExitCode) {
      return false;
    }

    throw error;
  }
}

function startupTaskXml(userSid: string, executablePath: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts Softshot as administrator when you sign in.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <UserId>${userSid}</UserId>
      <Delay>${startupTaskDelay}</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${userSid}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>${String(normalStartupTaskPriority)}</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(executablePath)}</Command>
    </Exec>
  </Actions>
</Task>
`;
}

function escapeXml(value: string): string {
  return value.replaceAll(/["&'<>]/gu, (character) => xmlEscapes[character]);
}
