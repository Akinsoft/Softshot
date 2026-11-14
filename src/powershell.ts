import { runWindowsCommand } from "./windows-command";

const powershellExecutable = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const clipboardFileEnvironmentName = "SOFTSHOT_CLIPBOARD_FILE";
const windowProcessSeparator = "\t";
const windowHandleEnvironmentName = "SOFTSHOT_WINDOW_HANDLE";
const geometryFieldSeparator = "\t";
const monitorFieldCount = 5;
const windowFieldCount = 3;

const fileClipboardScript = `
Add-Type -AssemblyName System.Windows.Forms
$file = [Environment]::GetEnvironmentVariable("${clipboardFileEnvironmentName}")
if ([string]::IsNullOrWhiteSpace($file)) {
  throw "Missing ${clipboardFileEnvironmentName}."
}
$files = New-Object System.Collections.Specialized.StringCollection
[void] $files.Add($file)
[System.Windows.Forms.Clipboard]::SetFileDropList($files)
`;

const utf8OutputCommand = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8";

const recognizedGameScript = String.raw`
${utf8OutputCommand}
Get-ChildItem -Path "Registry::HKEY_CURRENT_USER\System\GameConfigStore\Children" -ErrorAction SilentlyContinue | ForEach-Object {
  $_.GetValue("MatchedExeFullPath")
} | Where-Object { $_ }
`;

const windowProcessScript = `
${utf8OutputCommand}
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class SoftshotProcessPath {
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder path, ref int size);

  public static string Of(int processId) {
    IntPtr process = OpenProcess(0x1000, false, processId);
    if (process == IntPtr.Zero) {
      return "";
    }
    try {
      StringBuilder path = new StringBuilder(32768);
      int size = path.Capacity;
      return QueryFullProcessImageName(process, 0, path, ref size) ? path.ToString() : "";
    } finally {
      CloseHandle(process);
    }
  }
}
"@
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
  "{0}${windowProcessSeparator}{1}${windowProcessSeparator}{2}" -f $_.MainWindowHandle.ToInt64(), $_.ProcessName, [SoftshotProcessPath]::Of($_.Id)
}
`;

const captureGeometryScript = String.raw`
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class SoftshotCaptureGeometry {
  [StructLayout(LayoutKind.Sequential)]
  public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }

  delegate bool MonitorEnumProc(IntPtr monitor, IntPtr deviceContext, ref Rect bounds, IntPtr data);

  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr deviceContext, IntPtr clip, MonitorEnumProc callback, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect bounds);

  public static string Describe(long windowHandle) {
    SetThreadDpiAwarenessContext(new IntPtr(-4));
    StringBuilder output = new StringBuilder();
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr monitor, IntPtr deviceContext, ref Rect bounds, IntPtr data) {
      output.AppendFormat("monitor\t{0}\t{1}\t{2}\t{3}\t{4}\n", monitor.ToInt64(), bounds.Left, bounds.Top, bounds.Right, bounds.Bottom);
      return true;
    }, IntPtr.Zero);
    IntPtr window = new IntPtr(windowHandle);
    Rect client;
    if (windowHandle != 0 && IsWindow(window) && GetClientRect(window, out client)) {
      output.AppendFormat("window\t{0}\t{1}\t{2}\n", IsIconic(window) ? 1 : 0, client.Right - client.Left, client.Bottom - client.Top);
    }
    return output.ToString();
  }
}
"@
[SoftshotCaptureGeometry]::Describe([long][Environment]::GetEnvironmentVariable("${windowHandleEnvironmentName}"))
`;

export interface MonitorGeometry {
  bottom: number;
  handle: string;
  left: number;
  right: number;
  top: number;
}

export interface WindowProcess {
  executablePath: string | null;
  name: string;
}

interface WindowGeometry {
  height: number;
  isMinimized: boolean;
  width: number;
}

interface CaptureGeometry {
  monitors: MonitorGeometry[];
  window: WindowGeometry | null;
}

export async function captureGeometry(windowHandle: string | null): Promise<CaptureGeometry> {
  const output = await runPowershellScript(
    captureGeometryScript,
    { [windowHandleEnvironmentName]: windowHandle ?? "0" },
    "Could not read the monitor and window layout."
  );
  const geometry: CaptureGeometry = { monitors: [], window: null };
  for (const line of output.split(/\r?\n/u)) {
    const [kind, ...fields] = line.trim().split(geometryFieldSeparator);
    if (kind === "monitor" && fields.length === monitorFieldCount) {
      const [handle, left, top, right, bottom] = fields;
      geometry.monitors.push({ bottom: Number(bottom), handle, left: Number(left), right: Number(right), top: Number(top) });
    } else if (kind === "window" && fields.length === windowFieldCount) {
      const [isMinimized, width, height] = fields;
      geometry.window = { height: Number(height), isMinimized: isMinimized === "1", width: Number(width) };
    }
  }

  return geometry;
}

export async function writeFileDropListToClipboard(filePath: string): Promise<void> {
  if (process.platform !== "win32") {
    throw new Error("Copying a recording as a file is only supported on Windows.");
  }

  await runPowershellScript(
    fileClipboardScript,
    { [clipboardFileEnvironmentName]: filePath },
    "Could not put the recording file on the clipboard."
  );
}

export async function windowsRecognizedGamePaths(): Promise<string[]> {
  const output = await runPowershellScript(recognizedGameScript, {}, "Could not read the games Windows recognizes.");
  return output.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
}

export async function windowProcesses(): Promise<Map<string, WindowProcess>> {
  const output = await runPowershellScript(windowProcessScript, {}, "Could not read the list of open apps.");
  const processes = new Map<string, WindowProcess>();
  for (const line of output.split(/\r?\n/u)) {
    const [windowHandle, name, executablePath] = line.trim().split(windowProcessSeparator);
    if (windowHandle && name) {
      processes.set(windowHandle, { executablePath: executablePath || null, name });
    }
  }

  return processes;
}

async function runPowershellScript(
  script: string,
  environment: Record<string, string>,
  failureMessage: string
): Promise<string> {
  return await runWindowsCommand(
    powershellExecutable,
    ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script],
    failureMessage,
    environment
  );
}
