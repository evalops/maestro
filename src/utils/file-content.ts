export function isProbablyBinary(buffer: Buffer): boolean {
	for (const byte of buffer.subarray(0, 2048)) {
		if (byte === 0) {
			return true;
		}
	}
	return false;
}
