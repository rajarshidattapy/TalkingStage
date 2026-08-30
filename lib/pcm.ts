/**
 * Sarvam's realtime endpoint accepts `linear16` only: mono 16-bit little-endian
 * PCM. The browser hands us Float32 samples from an AudioWorklet, so this is
 * the one conversion the fallback transcription path depends on.
 */
export function floatToPcm16(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
  }
  return pcm;
}

export function mergePcm16(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((length, chunk) => length + chunk.length, 0);
  const merged = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}
