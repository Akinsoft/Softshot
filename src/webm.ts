const webmClusterByteA = 0x1F;
const webmClusterByteB = 0x43;
const webmClusterByteC = 0xB6;
const webmClusterByteD = 0x75;
const webmClusterSignature = [webmClusterByteA, webmClusterByteB, webmClusterByteC, webmClusterByteD] as const;

export function hasWebmCluster(bytes: Uint8Array): boolean {
  if (bytes.byteLength < webmClusterSignature.length) {
    return false;
  }

  const lastStartOffset = bytes.byteLength - webmClusterSignature.length;
  for (let offset = 0; offset <= lastStartOffset; offset += 1) {
    if (hasSignatureAt(bytes, offset)) {
      return true;
    }
  }

  return false;
}

function hasSignatureAt(bytes: Uint8Array, offset: number): boolean {
  return webmClusterSignature.every((expectedByte, byteIndex) => bytes[offset + byteIndex] === expectedByte);
}
