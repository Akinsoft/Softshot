const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");

const projectDirectory = path.resolve(__dirname, "..");

async function importDist(moduleName) {
  return await import(pathToFileURL(path.join(projectDirectory, "dist", "browser", `${moduleName}.js`)).href);
}

test("video bitrate scales with pixels and frame rate within safe bounds", async () => {
  const { videoBitrate } = await importDist("video-bitrate");

  assert.equal(videoBitrate(1280, 720, 30), 4_500_000);
  assert.equal(videoBitrate(1280, 720, 60), 5_625_000);
  assert.equal(videoBitrate(1920, 1080, 30), 10_125_000);
  assert.equal(videoBitrate(160, 90, 30), 1_000_000);
  assert.equal(videoBitrate(7680, 2160, 60), 20_000_000);
  assert.throws(() => videoBitrate(0, 1080, 60), /positive finite/);
});

test("recording output stays within standard quality bounds without changing aspect ratio", async () => {
  const { recordingOutputSize } = await importDist("recording-output-size");

  assert.deepEqual(
    recordingOutputSize(
      { height: 1440, width: 2560, x: 0, y: 0 },
      "1080p",
      { height: 1440, width: 2560 },
      { height: 1440, width: 2560 }
    ),
    { height: 1080, width: 1920 }
  );
  assert.deepEqual(
    recordingOutputSize(
      { height: 1080, width: 2054, x: 0, y: 0 },
      "1080p",
      { height: 1440, width: 2560 },
      { height: 1440, width: 2560 }
    ),
    { height: 1010, width: 1920 }
  );
  assert.deepEqual(
    recordingOutputSize(
      { height: 1440, width: 2560, x: 0, y: 0 },
      "720p",
      { height: 1440, width: 2560 },
      { height: 1440, width: 2560 }
    ),
    { height: 720, width: 1280 }
  );
});

test("recording frame deadlines do not accumulate drawing time or burst after delays", async () => {
  const { nextRecordingFrameDeadline } = await importDist("recording-frame-clock");
  const frameIntervalMs = 1000 / 60;

  assert.equal(nextRecordingFrameDeadline(100, 101, frameIntervalMs), 100 + frameIntervalMs);
  assert.equal(nextRecordingFrameDeadline(100, 140, frameIntervalMs), 150);
  assert.throws(() => nextRecordingFrameDeadline(100, 101, 0), /interval must be positive/);
});

test("audio mix gain prevents summed sources from clipping", async () => {
  const { audioMixGain } = await importDist("audio-quality");

  assert.equal(audioMixGain(1), 1);
  assert.equal(audioMixGain(2), 0.5);
  assert.throws(() => audioMixGain(0), /at least one source/);
});

test("WebM validation detects clusters without accepting partial signatures", async () => {
  const { hasWebmCluster } = await importDist("webm");

  assert.equal(hasWebmCluster(Uint8Array.from([0, 0x1F, 0x43, 0xB6, 0x75, 0])), true);
  assert.equal(hasWebmCluster(Uint8Array.from([0x1F, 0x43, 0xB6])), false);
  assert.equal(hasWebmCluster(Uint8Array.from([0x1F, 0x43, 0xB6, 0x74])), false);
});

test("settings writes replace the file and remove the temporary file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "softshot-settings-"));
  const { loadAppSettings, saveAppSettings } = require(path.join(projectDirectory, "dist", "main", "app-settings.js"));
  const settings = {
    captureShortcut: "Control+PrintScreen",
    launchAtStartup: true,
    microphoneDeviceId: "default",
    systemAudioEnabled: false
  };

  try {
    await saveAppSettings(directory, { ...settings, systemAudioEnabled: true });
    await saveAppSettings(directory, settings);
    assert.deepEqual(await loadAppSettings(directory, false), settings);
    await assert.rejects(readFile(path.join(directory, "settings.json.tmp")), { code: "ENOENT" });
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});

test("shared recording files expire sooner than unsaved recovery files", () => {
  const {
    recordingRetentionMs,
    shortLivedRecordingFilePrefix,
    shortLivedRecordingRetentionMs,
    standardRecordingRetentionMs
  } = require(path.join(projectDirectory, "dist", "main", "temporary-retention.js"));

  assert.equal(recordingRetentionMs(`${shortLivedRecordingFilePrefix}clip.mp4`), shortLivedRecordingRetentionMs);
  assert.equal(recordingRetentionMs("Softshot unsaved.mp4"), standardRecordingRetentionMs);
  assert.equal(shortLivedRecordingRetentionMs, 20 * 60 * 1000);
  assert.equal(standardRecordingRetentionMs, 7 * 24 * 60 * 60 * 1000);
});
