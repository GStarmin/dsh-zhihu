// ffmpeg resolution extracted from qq-bridge's voice-core.js (MIT).
import fs from 'node:fs';
export function resolveFfmpeg({ ffmpegPath = null, envVar = 'FFMPEG_PATH' } = {}) {
  for (const candidate of [ffmpegPath, process.env[envVar]].filter(Boolean)) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return 'ffmpeg';
}
