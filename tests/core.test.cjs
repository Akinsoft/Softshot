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

test("editor timeline cuts preserve source positions and close deleted gaps", async () => {
  const {
    deleteTimelineSegment,
    sourceRangesForTimelineRange,
    splitTimelineAt,
    timelineDuration,
    timelineLocationAt,
    timelineSegmentBounds,
    timelineTimeAfterDeletion
  } = await importDist("editor-timeline");

  let segments = [{ id: 1, sourceEnd: 60, sourceStart: 0 }];
  segments = splitTimelineAt(segments, 20, 2, 0.05).segments;
  segments = splitTimelineAt(segments, 40, 3, 0.05).segments;

  assert.deepEqual(segments, [
    { id: 1, sourceEnd: 20, sourceStart: 0 },
    { id: 2, sourceEnd: 40, sourceStart: 20 },
    { id: 3, sourceEnd: 60, sourceStart: 40 }
  ]);
  assert.deepEqual(timelineLocationAt(segments, 20), {
    segment: segments[1],
    segmentIndex: 1,
    sourceTime: 20,
    timelineEnd: 40,
    timelineStart: 20
  });
  assert.deepEqual(sourceRangesForTimelineRange(segments, { end: 60, start: 0 }), [
    { end: 60, start: 0 }
  ]);

  const deletedRange = timelineSegmentBounds(segments, 2);
  segments = deleteTimelineSegment(segments, 2);
  assert.equal(timelineDuration(segments), 40);
  assert.equal(timelineTimeAfterDeletion(45, deletedRange), 25);
  assert.deepEqual(sourceRangesForTimelineRange(segments, { end: 40, start: 0 }), [
    { end: 20, start: 0 },
    { end: 60, start: 40 }
  ]);
});

test("editor timeline trims across cuts and rejects destructive edge cases", async () => {
  const {
    deleteTimelineSegment,
    sourceRangesForTimelineRange,
    splitTimelineAt
  } = await importDist("editor-timeline");
  const segments = [
    { id: 1, sourceEnd: 20, sourceStart: 0 },
    { id: 3, sourceEnd: 60, sourceStart: 40 }
  ];

  assert.deepEqual(sourceRangesForTimelineRange(segments, { end: 25, start: 10 }), [
    { end: 20, start: 10 },
    { end: 45, start: 40 }
  ]);
  assert.throws(() => splitTimelineAt(segments, 0.01, 4, 0.05), /farther away/);
  assert.throws(() => deleteTimelineSegment([segments[0]], 1), /final timeline segment/);
});

test("editor timeline clip edges trim, ripple, and restore without overlapping", async () => {
  const {
    resizeTimelineSegment,
    sourceRangesForTimeline
  } = await importDist("editor-timeline");
  let segments = [
    { id: 1, sourceEnd: 20, sourceStart: 0 },
    { id: 2, sourceEnd: 40, sourceStart: 20 },
    { id: 3, sourceEnd: 60, sourceStart: 40 }
  ];

  segments = resizeTimelineSegment(segments, 1, "end", 15, 0.05, 60);
  segments = resizeTimelineSegment(segments, 2, "start", 25, 0.05, 60);
  assert.deepEqual(segments, [
    { id: 1, sourceEnd: 15, sourceStart: 0 },
    { id: 2, sourceEnd: 40, sourceStart: 25 },
    { id: 3, sourceEnd: 60, sourceStart: 40 }
  ]);
  assert.deepEqual(sourceRangesForTimeline(segments), [
    { end: 15, start: 0 },
    { end: 60, start: 25 }
  ]);

  segments = resizeTimelineSegment(segments, 1, "end", 100, 0.05, 60);
  assert.equal(segments[0].sourceEnd, 25);
  segments = resizeTimelineSegment(segments, 2, "start", -100, 0.05, 60);
  assert.equal(segments[1].sourceStart, 25);
  segments = resizeTimelineSegment(segments, 3, "start", 59.99, 0.05, 60);
  assert.equal(segments[2].sourceStart, 59.95);
});

test("editor timeline clips reorder without losing source-aware trim bounds", async () => {
  const {
    moveTimelineSegment,
    resizeTimelineSegment,
    sourceRangesForTimeline
  } = await importDist("editor-timeline");
  let segments = [
    { id: 1, sourceEnd: 20, sourceStart: 0 },
    { id: 2, sourceEnd: 40, sourceStart: 20 },
    { id: 3, sourceEnd: 60, sourceStart: 40 }
  ];

  segments = moveTimelineSegment(segments, 3, 0);
  assert.deepEqual(segments.map((segment) => segment.id), [3, 1, 2]);
  assert.deepEqual(sourceRangesForTimeline(segments), [
    { end: 60, start: 40 },
    { end: 40, start: 0 }
  ]);

  segments = resizeTimelineSegment(segments, 2, "start", 25, 0.05, 60);
  assert.deepEqual(segments, [
    { id: 3, sourceEnd: 60, sourceStart: 40 },
    { id: 1, sourceEnd: 20, sourceStart: 0 },
    { id: 2, sourceEnd: 40, sourceStart: 25 }
  ]);
  assert.throws(() => moveTimelineSegment(segments, 2, 3), /destination is invalid/);
});

test("timeline thumbnail sampling stays lightweight and follows retained clip ranges", async () => {
  const {
    timelineThumbnailsForSegment,
    timelineThumbnailTimes
  } = await importDist("editor-thumbnails");
  const thumbnails = timelineThumbnailTimes(10, 4).map((sourceTime, index) => ({
    sourceTime,
    url: `preview-${String(index)}`
  }));

  assert.deepEqual(thumbnails.map((thumbnail) => thumbnail.sourceTime), [1.25, 3.75, 6.25, 8.75]);
  assert.deepEqual(
    timelineThumbnailsForSegment(thumbnails, { id: 1, sourceEnd: 7, sourceStart: 3 }).map((thumbnail) => thumbnail.sourceTime),
    [3.75, 6.25]
  );
  assert.deepEqual(
    timelineThumbnailsForSegment(thumbnails, { id: 2, sourceEnd: 5.1, sourceStart: 4.9 }).map((thumbnail) => thumbnail.sourceTime),
    [3.75]
  );
  assert.throws(() => timelineThumbnailTimes(10, 0), /positive integer/);
});

test("audio waveforms follow retained timeline sections", async () => {
  const { timelineWaveformPeaks } = await importDist("editor-waveform-view");
  const sourcePeaks = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
  const segments = [
    { id: 1, sourceEnd: 2, sourceStart: 0 },
    { id: 2, sourceEnd: 6, sourceStart: 4 }
  ];

  assert.deepEqual(timelineWaveformPeaks(sourcePeaks, 6, segments, 4), [0, 0.1, 0.4, 0.5]);
  assert.throws(() => timelineWaveformPeaks([], 6, segments, 4), /normalized finite values/);
});
