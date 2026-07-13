const path = require("node:path");
const { mkdtemp, rm, stat, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");

const { app, BrowserWindow } = require("electron");

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

async function run() {
  await app.whenReady();
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  await window.loadFile(path.join(__dirname, "electron-media-smoke.html"));
  const result = await window.webContents.executeJavaScript("globalThis.runMediaSmoke()");
  const compatibilityBytes = result.compatibility.bytes;
  delete result.compatibility.bytes;
  delete result.hardware.bytes;
  result.endTrim = await runEndTrimSmoke(compatibilityBytes, result.compatibility.videoPacketGapSeconds);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  window.destroy();
  app.exit(0);
}

async function runEndTrimSmoke(sourceBytes, sourceVideoPacketGapSeconds) {
  const directory = await mkdtemp(path.join(tmpdir(), "softshot-remux-"));
  const sourceFilePath = path.join(directory, "source.mp4");
  const targetFilePath = path.join(directory, "trimmed.mp4");
  let input = null;
  try {
    await writeFile(sourceFilePath, Buffer.from(sourceBytes));
    const { remuxVideoEnd } = require("../dist/main/editor-remux.js");
    const startedAtMs = performance.now();
    await remuxVideoEnd(sourceFilePath, targetFilePath, "mp4", 0.6);
    const elapsedMs = performance.now() - startedAtMs;

    const { ALL_FORMATS, FilePathSource, Input } = require("mediabunny");
    input = new Input({ formats: ALL_FORMATS, source: new FilePathSource(targetFilePath) });
    if (!await input.canRead()) {
      throw new Error("Mediabunny could not read the end-trim smoke-test file.");
    }

    const durationSeconds = await input.computeDuration();
    const videoTracks = await input.getVideoTracks();
    const audioTracks = await input.getAudioTracks();
    const maximumDurationSeconds = 0.7 + sourceVideoPacketGapSeconds;
    if (durationSeconds < 0.5
      || durationSeconds > maximumDurationSeconds
      || videoTracks.length !== 1
      || audioTracks.length !== 1) {
      throw new Error(
        `The end-trim smoke test produced ${durationSeconds.toFixed(3)} seconds with a ${maximumDurationSeconds.toFixed(3)} second maximum, ${videoTracks.length} video tracks, and ${audioTracks.length} audio tracks.`
      );
    }

    return {
      audioCodec: await audioTracks[0].getCodec(),
      byteLength: (await stat(targetFilePath)).size,
      durationSeconds,
      elapsedMs: Math.round(elapsedMs),
      videoCodec: await videoTracks[0].getCodec()
    };
  } finally {
    input?.dispose();
    await rm(directory, { force: true, recursive: true });
  }
}

void run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  app.exit(1);
});
