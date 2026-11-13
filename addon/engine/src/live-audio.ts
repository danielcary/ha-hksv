import { Socket } from 'node:dgram';
import { AudioInfo, AudioStreamingCodecType, Source } from '@homebridge/hap-nodejs';
import { ProtectionProfileAes128CmHmacSha1_80, RtpPacket, SrtcpSession, SrtpSession } from 'werift-rtp';

export function opusArguments(audio: AudioInfo, volume: number): string[] {
  if (audio.codec !== AudioStreamingCodecType.OPUS || audio.channel !== 1
    || ![16, 24].includes(audio.sample_rate) || ![10, 20, 40, 60].includes(audio.packet_time)
    || !Number.isInteger(audio.pt) || audio.pt < 96 || audio.pt > 127
    || !Number.isFinite(audio.max_bit_rate) || audio.max_bit_rate < 6 || audio.max_bit_rate > 128) {
    throw new Error('Unsupported live audio configuration');
  }
  return ['-map', '0:a:0?', '-c:a', 'libopus', '-application', 'lowdelay', '-frame_duration', String(audio.packet_time),
    '-ar', String(audio.sample_rate * 1000), '-ac', '1', '-b:a', `${audio.max_bit_rate}k`, '-vbr', audio.bit_rate === 1 ? 'off' : 'on',
    '-af', `volume=${volume / 100}`];
}

export function forwardOpus(input: Socket, output: Socket, target: string, source: Source, ssrc: number,
  audio: AudioInfo, muted: () => boolean): void {
  const key = source.srtp_key, salt = source.srtp_salt;
  const config = {
    profile: ProtectionProfileAes128CmHmacSha1_80,
    keys: {localMasterKey: key, localMasterSalt: salt, remoteMasterKey: key, remoteMasterSalt: salt},
  };
  const srtp = new SrtpSession(config);
  const srtcp = new SrtcpSession(config);
  let lastTimestamp: number | undefined;
  let elapsedTicks = 0;
  let initialTimestamp = 0;
  const delta = (timestamp: number, base: number) => (timestamp - base) | 0;
  // FFmpeg uses the standard 48 kHz RTP clock for Opus. HomeKit expects
  // the negotiated sample rate in both RTP packets and RTCP sender reports.
  const homeKitTimestamp = (ticks: number) => (initialTimestamp + Math.round(ticks * audio.sample_rate / 48)) >>> 0;
  const send = (packet: Buffer) => output.send(packet, source.port, target, () => {});

  input.on('message', data => {
    if (data.length < 12 || data[0] >> 6 !== 2) return;
    if (data[1] >= 192 && data[1] <= 223) {
      if (muted() || lastTimestamp === undefined || data[1] !== 200 || data.length < 28 || data.readUInt32BE(4) !== ssrc) return;
      data.writeUInt32BE(homeKitTimestamp(elapsedTicks + delta(data.readUInt32BE(16), lastTimestamp)), 16);
      send(srtcp.encrypt(data));
      return;
    }
    // The local FFmpeg sender uses a fixed RTP header without CSRCs or extensions.
    if (data[0] !== 0x80 || (data[1] & 127) !== audio.pt || data.readUInt32BE(8) !== ssrc) return;
    const {header, payload} = RtpPacket.deSerialize(data);
    if (lastTimestamp === undefined) initialTimestamp = header.timestamp;
    else elapsedTicks += delta(header.timestamp, lastTimestamp);
    lastTimestamp = header.timestamp;
    header.timestamp = homeKitTimestamp(elapsedTicks);
    // Keep the SRTP sequence state current while muted, including at rollover.
    const packet = srtp.encrypt(payload, header);
    if (!muted()) send(packet);
  });
}
