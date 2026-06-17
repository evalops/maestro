import { StringDecoder } from "node:string_decoder";

type OutputCapture = {
	text: string;
	bytes: number;
	decoder: StringDecoder;
};

export function createOutputCapture(): OutputCapture {
	return {
		text: "",
		bytes: 0,
		decoder: new StringDecoder("utf8"),
	};
}

export function appendCapturedOutput(
	capture: OutputCapture,
	data: Buffer,
	maxBuffer: number,
): void {
	if (capture.bytes >= maxBuffer) {
		return;
	}

	const remainingBytes = maxBuffer - capture.bytes;
	const chunk =
		data.length <= remainingBytes ? data : data.subarray(0, remainingBytes);
	capture.text += capture.decoder.write(chunk);
	capture.bytes += chunk.length;
}

export function finalizeCapturedOutput(capture: OutputCapture): string {
	capture.text += capture.decoder.end();
	return capture.text;
}
