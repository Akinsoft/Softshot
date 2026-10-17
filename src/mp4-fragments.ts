const boxHeaderLength = 8;
const largeBoxHeaderLength = 16;
const largeBoxSizeMarker = 1;
const fullBoxHeaderLength = 4;
const sixtyFourBitVersion = 1;
const mdhdVersionOneTimescaleOffset = 20;
const mdhdVersionZeroTimescaleOffset = 12;
const trexDefaultDurationOffset = 12;
const tfhdBaseDataOffsetFlag = 0x1;
const tfhdSampleDescriptionFlag = 0x2;
const tfhdDefaultDurationFlag = 0x8;
const trunDataOffsetFlag = 0x1;
const trunFirstSampleFlagsFlag = 0x4;
const trunSampleDurationFlag = 0x1_00;
const trunSampleSizeFlag = 0x2_00;
const trunSampleFlagsFlag = 0x4_00;
const trunCompositionOffsetFlag = 0x8_00;
const uint32Length = 4;
const flagsByteLength = 3;
const uint64Length = 8;
const flagFieldMultiplier = 2;
const containerBoxTypes = new Set(["mdia", "minf", "moof", "moov", "mvex", "stbl", "traf", "trak"]);

export interface Mp4Fragment {
  bytes: Buffer;
  endSeconds: number;
  startSeconds: number;
}

interface Box {
  contentEnd: number;
  contentStart: number;
  type: string;
}

export class Mp4FragmentReader {
  private bufferedLength = 0;

  private readonly chunks: Buffer[] = [];

  private defaultSampleDuration = 0;

  private readonly headerBoxes: Buffer[] = [];

  private pendingMoof: Buffer | null = null;

  private timescale = 0;

  private peek(length: number): Buffer {
    const bytes = Buffer.alloc(length);
    let offset = 0;
    for (const chunk of this.chunks) {
      const copied = chunk.copy(bytes, offset, 0, Math.min(chunk.length, length - offset));
      offset += copied;
      if (offset === length) {
        break;
      }
    }

    return bytes;
  }

  private take(length: number): Buffer {
    const bytes = this.peek(length);
    let remaining = length;
    while (remaining > 0) {
      const [chunk] = this.chunks;
      if (chunk.length <= remaining) {
        this.chunks.shift();
        remaining -= chunk.length;
      } else {
        this.chunks[0] = chunk.subarray(remaining);
        remaining = 0;
      }
    }

    this.bufferedLength -= length;
    return bytes;
  }

  private nextBoxLength(): number | null {
    if (this.bufferedLength < boxHeaderLength) {
      return null;
    }

    const header = this.peek(Math.min(this.bufferedLength, largeBoxHeaderLength));
    const size = header.readUInt32BE(0);
    if (size !== largeBoxSizeMarker) {
      return size;
    }

    return header.length < largeBoxHeaderLength ? null : Number(header.readBigUInt64BE(boxHeaderLength));
  }

  private readHeaderBox(box: Buffer): void {
    this.headerBoxes.push(box);
    const mdhd = findBox(box, ["moov", "trak", "mdia", "mdhd"]);
    if (mdhd) {
      const version = box.readUInt8(mdhd.contentStart);
      const offset = version === sixtyFourBitVersion ? mdhdVersionOneTimescaleOffset : mdhdVersionZeroTimescaleOffset;
      this.timescale = box.readUInt32BE(mdhd.contentStart + offset);
    }

    const trex = findBox(box, ["moov", "mvex", "trex"]);
    if (trex) {
      this.defaultSampleDuration = box.readUInt32BE(trex.contentStart + trexDefaultDurationOffset);
    }
  }

  private fragmentFromMoof(moof: Buffer, mdat: Buffer): Mp4Fragment {
    if (this.timescale <= 0) {
      throw new Error("The video stream sent a fragment before its header.");
    }

    const tfdt = findBox(moof, ["moof", "traf", "tfdt"]);
    const tfhd = findBox(moof, ["moof", "traf", "tfhd"]);
    const trun = findBox(moof, ["moof", "traf", "trun"]);
    if (!tfdt || !tfhd || !trun) {
      throw new Error("The video stream sent an incomplete fragment.");
    }

    const startTicks = readDecodeTime(moof, tfdt);
    const durationTicks = trackRunDuration(moof, trun, defaultDuration(moof, tfhd) ?? this.defaultSampleDuration);
    return {
      bytes: Buffer.concat([moof, mdat]),
      endSeconds: (startTicks + durationTicks) / this.timescale,
      startSeconds: startTicks / this.timescale
    };
  }

  header(): Buffer[] {
    return [...this.headerBoxes];
  }

  push(chunk: Buffer): Mp4Fragment[] {
    this.chunks.push(chunk);
    this.bufferedLength += chunk.length;
    const fragments: Mp4Fragment[] = [];
    for (let boxLength = this.nextBoxLength(); boxLength !== null && boxLength <= this.bufferedLength; boxLength = this.nextBoxLength()) {
      const box = this.take(boxLength);
      const type = box.toString("latin1", uint32Length, boxHeaderLength);
      if (type === "moof") {
        this.pendingMoof = box;
      } else if (type === "mdat" && this.pendingMoof) {
        fragments.push(this.fragmentFromMoof(this.pendingMoof, box));
        this.pendingMoof = null;
      } else if (type === "ftyp" || type === "moov") {
        this.readHeaderBox(box);
      }
    }

    return fragments;
  }
}

function childBoxes(buffer: Buffer, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let offset = start;
  while (offset + boxHeaderLength <= end) {
    let size = buffer.readUInt32BE(offset);
    let headerLength = boxHeaderLength;
    if (size === largeBoxSizeMarker) {
      size = Number(buffer.readBigUInt64BE(offset + boxHeaderLength));
      headerLength = largeBoxHeaderLength;
    }

    if (size < headerLength || offset + size > end) {
      break;
    }

    boxes.push({
      contentEnd: offset + size,
      contentStart: offset + headerLength,
      type: buffer.toString("latin1", offset + uint32Length, offset + boxHeaderLength)
    });
    offset += size;
  }

  return boxes;
}

function findBox(buffer: Buffer, path: readonly string[]): Box | null {
  let candidates = childBoxes(buffer, 0, buffer.length);
  let match: Box | null = null;
  for (const type of path) {
    match = candidates.find((box) => box.type === type) ?? null;
    if (!match) {
      return null;
    }

    candidates = containerBoxTypes.has(type) ? childBoxes(buffer, match.contentStart, match.contentEnd) : [];
  }

  return match;
}

function boxFlags(buffer: Buffer, box: Box): number {
  return buffer.readUIntBE(box.contentStart + 1, flagsByteLength);
}

function hasFlag(flags: number, flag: number): boolean {
  return Math.floor(flags / flag) % flagFieldMultiplier === 1;
}

function readDecodeTime(buffer: Buffer, tfdt: Box): number {
  const version = buffer.readUInt8(tfdt.contentStart);
  const valueOffset = tfdt.contentStart + fullBoxHeaderLength;
  return version === sixtyFourBitVersion
    ? Number(buffer.readBigUInt64BE(valueOffset))
    : buffer.readUInt32BE(valueOffset);
}

function defaultDuration(buffer: Buffer, tfhd: Box): number | null {
  const flags = boxFlags(buffer, tfhd);
  if (!hasFlag(flags, tfhdDefaultDurationFlag)) {
    return null;
  }

  let offset = tfhd.contentStart + fullBoxHeaderLength + uint32Length;
  if (hasFlag(flags, tfhdBaseDataOffsetFlag)) {
    offset += uint64Length;
  }

  if (hasFlag(flags, tfhdSampleDescriptionFlag)) {
    offset += uint32Length;
  }

  return buffer.readUInt32BE(offset);
}

function trackRunDuration(buffer: Buffer, trun: Box, fallbackDuration: number): number {
  const flags = boxFlags(buffer, trun);
  const sampleCount = buffer.readUInt32BE(trun.contentStart + fullBoxHeaderLength);
  if (!hasFlag(flags, trunSampleDurationFlag)) {
    return sampleCount * fallbackDuration;
  }

  let offset = trun.contentStart + fullBoxHeaderLength + uint32Length;
  if (hasFlag(flags, trunDataOffsetFlag)) {
    offset += uint32Length;
  }

  if (hasFlag(flags, trunFirstSampleFlagsFlag)) {
    offset += uint32Length;
  }

  const sampleFieldLength = [trunSampleDurationFlag, trunSampleSizeFlag, trunSampleFlagsFlag, trunCompositionOffsetFlag]
    .filter((flag) => hasFlag(flags, flag)).length * uint32Length;
  let duration = 0;
  for (let sample = 0; sample < sampleCount; sample += 1) {
    duration += buffer.readUInt32BE(offset + sample * sampleFieldLength);
  }

  return duration;
}
