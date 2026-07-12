const hoursPerDay = 24;
const minutesToRetainSharedRecording = 20;
const minutesPerHour = 60;
const daysToRetainUnsavedRecording = 7;
const secondsPerMinute = 60;
const millisecondsPerSecond = 1000;

export const shortLivedRecordingFilePrefix = "Softshot Shared ";
export const shortLivedRecordingRetentionMs = minutesToRetainSharedRecording * secondsPerMinute * millisecondsPerSecond;
export const standardRecordingRetentionMs = daysToRetainUnsavedRecording
  * hoursPerDay
  * minutesPerHour
  * secondsPerMinute
  * millisecondsPerSecond;

export function recordingRetentionMs(fileName: string): number {
  return fileName.startsWith(shortLivedRecordingFilePrefix)
    ? shortLivedRecordingRetentionMs
    : standardRecordingRetentionMs;
}
