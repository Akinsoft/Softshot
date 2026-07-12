import type { VideoFileExtension } from "./shared";

export async function remuxVideoEnd(
  sourceFilePath: string,
  targetFilePath: string,
  fileExtension: VideoFileExtension,
  endSeconds: number
): Promise<void> {
  if (!Number.isFinite(endSeconds) || endSeconds <= 0) {
    throw new RangeError("The trim end must be a positive finite number.");
  }

  const {
    ALL_FORMATS,
    Conversion,
    FilePathSource,
    FilePathTarget,
    Input,
    Mp4OutputFormat,
    Output,
    WebMOutputFormat
  } = await import("mediabunny");
  const input = new Input({
    formats: ALL_FORMATS,
    source: new FilePathSource(sourceFilePath)
  });
  const output = new Output({
    format: fileExtension === "mp4" ? new Mp4OutputFormat({ fastStart: false }) : new WebMOutputFormat(),
    target: new FilePathTarget(targetFilePath)
  });
  try {
    const conversion = await Conversion.init({
      input,
      output,
      showWarnings: false,
      trim: { end: endSeconds }
    });
    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks.map((track) => track.reason).join(", ");
      const reasonDetails = reasons ? `: ${reasons}` : ".";
      throw new Error(`The recording cannot be remuxed${reasonDetails}`);
    }

    await conversion.execute();
  } finally {
    input.dispose();
  }
}
