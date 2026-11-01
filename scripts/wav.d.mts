export const SR: number;
export function readWav(path: string): Float32Array<ArrayBuffer>[];
export function writeWav(path: string, channels: Float32Array[]): void;
