import { Accessory, AudioStreamingCodecType, AudioStreamingSamplerate, CameraController, Categories, Characteristic, Service, uuid, Resolution } from '@homebridge/hap-nodejs';
import { CameraConfig, VIDEO_HEIGHT } from './config.js';
import { Identity } from './identity.js';
import { MotionDetector } from './motion.js';
import { RecordingDelegate } from './recording.js';
import { LIVE_STREAM_COUNT, StreamingDelegate } from './streaming.js';

const RESOLUTIONS: Resolution[] = [[1920, 1080, 30], [1920, 1080, 15], [1280, 720, 30], [1280, 720, 15],
  [640, 360, 30], [640, 360, 15], [320, 240, 15]];

export class HomeKitCamera {
  readonly accessory: Accessory;
  readonly recording: RecordingDelegate;
  readonly streaming: StreamingDelegate;
  readonly controller: CameraController;
  private readonly motionDetector?: MotionDetector;
  private externalMotion = false;
  private detectedMotion = false;
  private motion = false;
  private published = false;
  private recordingAudioActive = false;
  private microphoneMuted = false;
  constructor(readonly config: CameraConfig, readonly identity: Identity) {
    this.accessory = new Accessory(config.name, uuid.generate(`ha-hksv:${identity.username}`));
    this.accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'HA HKSV')
      .setCharacteristic(Characteristic.Model, config.rtspUrl === 'test://pattern' ? 'Test Camera' : 'RTSP Camera')
      .setCharacteristic(Characteristic.SerialNumber, identity.username.replaceAll(':', ''))
      .setCharacteristic(Characteristic.FirmwareRevision, '0.2.0');
    this.recording = new RecordingDelegate(config); this.streaming = new StreamingDelegate(config);
    if (config.softwareMotion) {
      this.motionDetector = new MotionDetector(config, active => {
        this.detectedMotion = active;
        this.updateMotion();
      });
    }
    const maxHeight = VIDEO_HEIGHT[config.maxResolution ?? '1080p'];
    const resolutions = RESOLUTIONS.filter(([, height]) => height <= maxHeight);
    this.controller = new CameraController({
      cameraStreamCount: LIVE_STREAM_COUNT, delegate: this.streaming,
      streamingOptions: {
        supportedCryptoSuites: [0],
        video: {codec: {profiles: [0, 1, 2], levels: [0, 1, 2]}, resolutions},
        audio: config.audio ? {codecs: [{type: AudioStreamingCodecType.OPUS, audioChannels: 1,
          samplerate: [AudioStreamingSamplerate.KHZ_16, AudioStreamingSamplerate.KHZ_24]}]} : undefined,
      },
      recording: {delegate: this.recording, options: {prebufferLength: 4000,
        mediaContainerConfiguration: {type: 0, fragmentLength: 4000},
        video: {type: 0, parameters: {profiles: [0, 1, 2], levels: [0, 1, 2]}, resolutions},
        audio: {codecs: {type: 0, samplerate: [5], audioChannels: 1}}}},
      sensors: {motion: true},
    });
    this.streaming.controller = this.controller;
    this.accessory.configureController(this.controller);
    const recordingService = this.controller.recordingManagement!.recordingManagementService;
    const updateRecordingAudio = (active: boolean) => {
      this.recordingAudioActive = active;
      this.recording.setAudioActive(active && !this.microphoneMuted);
    };
    recordingService.getCharacteristic(Characteristic.RecordingAudioActive).on('change', change => updateRecordingAudio(Boolean(change.newValue)));
    this.controller.on('microphone-change', (muted, volume) => {
      this.microphoneMuted = muted;
      this.streaming.setMicrophone(muted, volume);
      updateRecordingAudio(this.recordingAudioActive);
    });
    this.controller.recordingManagement!.operatingModeService.getCharacteristic(Characteristic.HomeKitCameraActive).on('change', change => {
      this.setEnabled(Boolean(change.newValue));
    });
  }
  async publish() {
    await this.accessory.publish({...this.identity, category: Categories.IP_CAMERA, bind: process.env.HKSV_HOMEKIT_INTERFACE});
    this.published = true;
    // HAP restores persisted characteristics while publishing.
    this.recordingAudioActive = Boolean(this.controller.recordingManagement!.recordingManagementService.getCharacteristic(Characteristic.RecordingAudioActive).value);
    this.recording.setAudioActive(this.recordingAudioActive && !this.microphoneMuted);
    const enabled = Boolean(this.controller.recordingManagement!.operatingModeService.getCharacteristic(Characteristic.HomeKitCameraActive).value);
    this.setEnabled(enabled);
  }
  private setEnabled(enabled: boolean) {
    this.streaming.setEnabled(enabled);
    this.recording.setEnabled(enabled);
    this.motionDetector?.setEnabled(this.published && enabled);
  }
  setMotion(active: boolean) {
    this.externalMotion = active;
    this.updateMotion();
  }
  private updateMotion() {
    const active = this.externalMotion || this.detectedMotion;
    if (active === this.motion) return;
    this.motion = active;
    this.recording.setMotion(active);
    this.controller.motionService!.updateCharacteristic(Characteristic.MotionDetected, active);
  }
  pairing() { return {pincode: this.identity.pincode, setupUri: this.published ? this.accessory.setupURI() : undefined}; }
  status() {
    return {status: this.published ? 'published' : 'not_published', recording: this.recording.status,
      source: this.config.rtspUrl === 'test://pattern' ? 'test' : 'rtsp', audio: this.config.audio === true,
      motion: this.motion, motionDetector: this.motionDetector?.status ?? 'disabled',
      maxResolution: this.config.maxResolution ?? '1080p'};
  }
  async close() {
    this.published = false;
    this.motionDetector?.setEnabled(false);
    this.recording.close(); this.streaming.close(); await this.accessory.unpublish();
  }
}
