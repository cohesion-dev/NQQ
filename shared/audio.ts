export interface LinxAudioParams {
  format: 'opus' | 'pcm';
  sample_rate: 8000 | 12000 | 16000 | 24000 | 48000;
  channels: 1;
}

/** 只接受播放器支持的单声道参数，避免把压缩音频当作裸采样播放。 */
export function readAudioParams(value: unknown): LinxAudioParams {
  const params = value as Record<string, unknown> | null;
  if (!params || !['opus', 'pcm'].includes(String(params.format))
    || ![8000, 12000, 16000, 24000, 48000].includes(Number(params.sample_rate))
    || params.channels !== 1
    || (params.format === 'pcm' && ((params.bit_depth !== undefined && params.bit_depth !== 16)
      || (params.endianness !== undefined && params.endianness !== 'little')))) {
    throw new Error('UNSUPPORTED_AUDIO_PARAMS');
  }
  return { format: params.format as LinxAudioParams['format'], sample_rate: Number(params.sample_rate) as LinxAudioParams['sample_rate'], channels: 1 };
}
