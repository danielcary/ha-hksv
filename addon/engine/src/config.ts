export const VIDEO_HEIGHT = {'360p': 360, '720p': 720, '1080p': 1080} as const;
type VideoResolution = keyof typeof VIDEO_HEIGHT;

export interface CameraConfig {
  id: string;
  name: string;
  rtspUrl: string;
  audio?: boolean;
  softwareMotion?: boolean;
  maxResolution?: VideoResolution;
}
export function parseCamera(value: unknown): CameraConfig {
  if (!value || typeof value !== 'object') throw new Error('Expected camera object');
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(v.id)) throw new Error('Invalid camera id');
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 64) throw new Error('Invalid camera name');
  if (typeof v.rtspUrl !== 'string' || v.rtspUrl.length > 4096) throw new Error('Invalid RTSP URL');
  if (v.audio !== undefined && typeof v.audio !== 'boolean') throw new Error('Invalid audio setting');
  if (v.softwareMotion !== undefined && typeof v.softwareMotion !== 'boolean') throw new Error('Invalid motion setting');
  if (v.maxResolution !== undefined && (typeof v.maxResolution !== 'string' || !Object.hasOwn(VIDEO_HEIGHT, v.maxResolution))) {
    throw new Error('Invalid maximum resolution');
  }
  const camera: CameraConfig = {id: v.id, name: v.name.trim(), rtspUrl: v.rtspUrl};
  if (v.audio === true) camera.audio = true;
  if (v.softwareMotion === true) camera.softwareMotion = true;
  if (v.maxResolution === '360p' || v.maxResolution === '720p') camera.maxResolution = v.maxResolution;
  if (v.rtspUrl === 'test://pattern') return camera;
  let url: URL;
  try { url = new URL(v.rtspUrl); } catch { throw new Error('Invalid RTSP URL'); }
  if (!['rtsp:', 'rtsps:'].includes(url.protocol) || !url.hostname || /[\r\n\0]/.test(v.rtspUrl)) throw new Error('Invalid RTSP URL');
  return camera;
}
