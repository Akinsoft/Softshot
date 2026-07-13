import {
  ALL_FORMATS,
  AppendOnlyStreamTarget,
  BlobSource,
  EncodedPacketSink,
  Input,
  MediaStreamAudioTrackSource,
  MediaStreamVideoTrackSource,
  Mp4OutputFormat,
  Output
} from "../node_modules/mediabunny/dist/bundles/mediabunny.min.mjs";

import {
  recordingAudioBitrate,
  recordingAudioChannelCount,
  recordingAudioSampleRate
} from "../dist/browser/audio-quality.js";
import { hardwareVideoCodecs } from "../dist/browser/video-codecs.js";

const frameRate = 30;
const recordingDurationMs = 1200;
const recorderStopTimeoutMs = 10_000;
const minimumVideoPacketCount = 10;
const videoBitrate = 1_000_000;
const videoHeight = 180;
const videoWidth = 320;

const mimeTypes = [
  "video/mp4;codecs=avc1.640028,mp4a.40.2",
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/webm;codecs=vp8,opus",
  "video/webm;codecs=vp9,opus",
  "video/webm"
];

globalThis.runMediaSmoke = async function runMediaSmoke() {
  const compatibility = await runCompatibilitySmoke();
  const hardware = await runHardwareSmoke();
  const editedSource = hardware.supported ? hardware : compatibility;
  return {
    compatibility,
    editedCut: await runEditedCutSmoke(editedSource),
    hardware
  };
};

async function runEditedCutSmoke(source) {
  const sourceBytes = Uint8Array.from(source.bytes);
  const outputChunks = [];
  const recordingId = "edited-cut";
  globalThis.softshot = {
    appendRecordingFileChunk: async (id, bytes) => {
      if (id !== recordingId) {
        throw new Error("The edited-cut smoke test received an unexpected recording identifier.");
      }

      outputChunks.push(bytes.slice());
    },
    createRecordingFile: async () => ({ id: recordingId }),
    discardRecordingFile: async (id) => {
      if (id === recordingId) {
        outputChunks.length = 0;
      }
    },
    getEditorVideoFileSize: async () => sourceBytes.length,
    readEditorVideoFile: async (start, end) => sourceBytes.slice(start, end),
    getEditorAudioFileSize: async () => sourceBytes.length,
    readEditorAudioFile: async (kind, start, end) => {
      if (kind !== "system" && kind !== "microphone") {
        throw new Error("The media smoke test received an unexpected audio track type.");
      }

      return sourceBytes.slice(start, end);
    }
  };

  try {
    const { audioWaveformPeaks } = await import("../dist/browser/audio-waveform.js");
    const waveformPeaks = await audioWaveformPeaks("system", source.durationSeconds, 64);
    const maximumWaveformPeak = Math.max(...waveformPeaks);
    if (waveformPeaks.length !== 64 || maximumWaveformPeak <= 0 || maximumWaveformPeak > 1) {
      throw new Error("The audio waveform smoke test did not produce normalized peaks.");
    }

    const { exportEditedVideo } = await import("../dist/browser/editor-export.js");
    const exportStartedAtMs = performance.now();
    const exportedVideo = await exportEditedVideo(
      source.mimeType,
      frameRate,
      [
        { end: 0.35, start: 0 },
        { end: 1.15, start: 0.8 }
      ],
      [{ kind: "system" }, { kind: "microphone" }]
    );
    const exportElapsedMs = Math.round(performance.now() - exportStartedAtMs);
    const outputBlob = new Blob(outputChunks, { type: exportedVideo.mimeType });
    const inspection = await inspectMediaBlob(outputBlob, exportedVideo.mimeType);
    const maximumDurationSeconds = 0.85 + source.videoPacketGapSeconds;
    const maximumVideoPacketGapSeconds = Math.max(0.1, source.videoPacketGapSeconds + 0.05);
    const maximumAudioPacketGapSeconds = source.audioPacketGapSeconds + 0.05;
    if (inspection.durationSeconds < 0.55 || inspection.durationSeconds > maximumDurationSeconds) {
      throw new Error(`The edited-cut smoke test produced an unexpected ${String(inspection.durationSeconds)} second duration.`);
    }

    if (inspection.videoPacketGapSeconds > maximumVideoPacketGapSeconds
      || inspection.audioPacketGapSeconds > maximumAudioPacketGapSeconds) {
      throw new Error("The edited-cut smoke test introduced a gap between retained segments.");
    }

    return {
      ...inspection,
      exportElapsedMs,
      waveformPeakCount: waveformPeaks.length
    };
  } finally {
    delete globalThis.softshot;
  }
}

async function runCompatibilitySmoke() {
  const mimeType = mimeTypes.find((candidate) => MediaRecorder.isTypeSupported(candidate));
  if (!mimeType) {
    throw new Error("No supported audio/video MediaRecorder format was found.");
  }

  const canvas = createCanvas();
  const context = requiredCanvasContext(canvas);
  const audio = await createTestAudio();
  const canvasStream = canvas.captureStream(0);
  const stream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...audio.destination.stream.getAudioTracks()
  ]);
  const recorder = new MediaRecorder(stream, {
    audioBitsPerSecond: recordingAudioBitrate,
    mimeType,
    videoBitsPerSecond: videoBitrate
  });
  const chunks = [];
  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });

  const stopDrawing = startDrawing(context, canvasStream);
  try {
    audio.oscillator.start();
    recorder.start(250);
    await delay(recordingDurationMs);
    await stopRecorder(recorder);
  } finally {
    stopDrawing();
    if (recorder.state !== "inactive") {
      await stopRecorder(recorder);
    }

    audio.oscillator.stop();
    stopStream(stream);
    await audio.context.close();
  }

  const blob = new Blob(chunks, { type: recorder.mimeType });
  return {
    ...await inspectMediaBlob(blob, recorder.mimeType),
    bytes: Array.from(new Uint8Array(await blob.arrayBuffer()))
  };
}

async function runHardwareSmoke() {
  const fullCodecString = await supportedHardwareCodec();
  if (!fullCodecString) {
    return { supported: false };
  }

  const canvas = createCanvas();
  const context = requiredCanvasContext(canvas);
  const audio = await createTestAudio();
  const canvasStream = canvas.captureStream(0);
  const stream = new MediaStream([
    ...canvasStream.getVideoTracks(),
    ...audio.destination.stream.getAudioTracks()
  ]);
  const videoTrack = stream.getVideoTracks()[0];
  const audioTrack = stream.getAudioTracks()[0];
  if (!videoTrack || !audioTrack) {
    throw new Error("The hardware media smoke test could not create source tracks.");
  }

  const chunks = [];
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: "fragmented", minimumFragmentDuration: 1 }),
    target: new AppendOnlyStreamTarget(new WritableStream({
      write(bytes) {
        chunks.push(bytes.slice());
      }
    }))
  });
  const encodingConfig = {
    bitrate: videoBitrate,
    codec: "avc",
    contentHint: "detail",
    fullCodecString,
    hardwareAcceleration: "prefer-hardware",
    keyFrameInterval: 2,
    latencyMode: "realtime"
  };
  const videoSource = new MediaStreamVideoTrackSource(videoTrack, encodingConfig, { frameRate });
  const audioSource = new MediaStreamAudioTrackSource(audioTrack, {
    bitrate: recordingAudioBitrate,
    codec: "aac"
  });
  let sourceError = null;
  void videoSource.errorPromise.catch((error) => {
    sourceError = error;
  });
  void audioSource.errorPromise.catch((error) => {
    sourceError = error;
  });
  output.addVideoTrack(videoSource, { frameRate });
  output.addAudioTrack(audioSource);

  const stopDrawing = startDrawing(context, canvasStream);
  try {
    audio.oscillator.start();
    await output.start();
    await delay(recordingDurationMs);
    await output.finalize();
    if (sourceError) {
      throw sourceError;
    }
  } finally {
    stopDrawing();
    if (output.state !== "canceled" && output.state !== "finalized") {
      await output.cancel();
    }

    audio.oscillator.stop();
    stopStream(stream);
    await audio.context.close();
  }

  const mimeType = `video/mp4;codecs=${fullCodecString},mp4a.40.2`;
  const blob = new Blob(chunks, { type: mimeType });
  return {
    ...await inspectMediaBlob(blob, mimeType),
    bytes: Array.from(new Uint8Array(await blob.arrayBuffer())),
    supported: true
  };
}

async function supportedHardwareCodec() {
  if (typeof VideoEncoder === "undefined" || typeof AudioEncoder === "undefined") {
    return null;
  }

  const audioSupport = await AudioEncoder.isConfigSupported({
    bitrate: recordingAudioBitrate,
    codec: "mp4a.40.2",
    numberOfChannels: recordingAudioChannelCount,
    sampleRate: recordingAudioSampleRate
  });
  if (!audioSupport.supported) {
    return null;
  }

  for (const codec of hardwareVideoCodecs) {
    const support = await VideoEncoder.isConfigSupported({
      bitrate: videoBitrate,
      codec,
      framerate: frameRate,
      hardwareAcceleration: "prefer-hardware",
      height: videoHeight,
      latencyMode: "realtime",
      width: videoWidth
    });
    if (support.supported) {
      return codec;
    }
  }

  return null;
}

async function createTestAudio() {
  const context = new AudioContext({ sampleRate: recordingAudioSampleRate });
  const destination = context.createMediaStreamDestination();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  gain.gain.value = 0.2;
  oscillator.frequency.value = 440;
  oscillator.connect(gain).connect(destination);
  await context.resume();
  return { context, destination, oscillator };
}

function createCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = videoWidth;
  canvas.height = videoHeight;
  return canvas;
}

function requiredCanvasContext(canvas) {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("Could not create the media smoke-test canvas.");
  }

  return context;
}

function startDrawing(context, stream) {
  let frame = 0;
  const track = stream.getVideoTracks()[0];
  if (!(track instanceof CanvasCaptureMediaStreamTrack)) {
    throw new Error("The media smoke test could not create a canvas capture track.");
  }

  const drawFrame = () => {
    frame += 1;
    context.fillStyle = frame % 2 === 0 ? "#38bdf8" : "#f43f5e";
    context.fillRect(0, 0, videoWidth, videoHeight);
    context.fillStyle = "#ffffff";
    context.fillRect(frame % videoWidth, 40, 30, 100);
    track.requestFrame();
  };
  drawFrame();
  const drawInterval = setInterval(drawFrame, 1000 / frameRate);
  return () => {
    clearInterval(drawInterval);
  };
}

async function inspectMediaBlob(blob, mimeType) {
  if (blob.size === 0) {
    throw new Error("The media smoke test produced an empty file.");
  }

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    if (!await input.canRead()) {
      throw new Error("Mediabunny could not read the media smoke-test file.");
    }

    const videoTracks = await input.getVideoTracks();
    const audioTracks = await input.getAudioTracks();
    if (videoTracks.length !== 1 || audioTracks.length !== 1) {
      throw new Error(`Expected one video and one audio track, found ${String(videoTracks.length)} and ${String(audioTracks.length)}.`);
    }

    const [videoTrack] = videoTracks;
    const [audioTrack] = audioTracks;
    const audioChannels = await audioTrack.getNumberOfChannels();
    const audioCodec = await audioTrack.getCodec();
    const audioPacketGapSeconds = await maximumPacketGap(audioTrack);
    const encodedAudioSampleRate = await audioTrack.getSampleRate();
    const durationSeconds = await input.computeDuration();
    const videoCodec = await videoTrack.getCodec();
    const videoPacketStats = await videoTrack.computePacketStats();
    const videoPacketGapSeconds = await maximumPacketGap(videoTrack);
    if (!audioCodec
      || !videoCodec
      || audioChannels < 1
      || encodedAudioSampleRate !== recordingAudioSampleRate
      || durationSeconds < 0.5
      || videoPacketStats.packetCount < minimumVideoPacketCount) {
      throw new Error("The media smoke-test tracks did not contain the expected encoded audio and video data.");
    }

    return {
      audioChannels,
      audioCodec,
      audioPacketGapSeconds,
      audioSampleRate: encodedAudioSampleRate,
      byteLength: blob.size,
      durationSeconds,
      mimeType,
      videoCodec,
      videoPacketGapSeconds,
      videoPacketCount: videoPacketStats.packetCount
    };
  } finally {
    input.dispose();
  }
}

async function maximumPacketGap(track) {
  const packetTimestamps = [];
  const sink = new EncodedPacketSink(track);
  for await (const packet of sink.packets()) {
    packetTimestamps.push(packet.timestamp);
  }

  packetTimestamps.sort((left, right) => left - right);
  let maximumGap = 0;
  for (let index = 1; index < packetTimestamps.length; index += 1) {
    maximumGap = Math.max(maximumGap, packetTimestamps[index] - packetTimestamps[index - 1]);
  }

  return maximumGap;
}

function stopStream(stream) {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

async function delay(milliseconds) {
  await new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function stopRecorder(recorder) {
  await new Promise((resolve, reject) => {
    let timeoutHandle = null;
    function cleanup() {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }

      recorder.removeEventListener("stop", onStop);
    }
    function onStop() {
      cleanup();
      resolve();
    }

    recorder.addEventListener("stop", onStop, { once: true });
    timeoutHandle = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out stopping the media smoke-test recorder."));
    }, recorderStopTimeoutMs);
    recorder.stop();
  });
}
