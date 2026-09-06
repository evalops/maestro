#!/usr/bin/env node

const chunks = [];

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
	let request = {};
	try {
		request = JSON.parse(chunks.join("") || "{}");
	} catch {
		console.log(JSON.stringify({ available: false, error: "invalid-json" }));
		return;
	}

	const deviceId = process.env.MAESTRO_FAKE_DEVICE_ID ?? "desktop-test-device";
	const publicKey =
		process.env.MAESTRO_FAKE_PUBLIC_KEY_SPKI ?? "fake-p256-public-key-spki";
	const base = {
		available: true,
		device_id: deviceId,
		key_algorithm: "p256_ecdsa_sha256",
		key_origin: "secure_enclave",
		public_key_spki: publicKey,
	};

	if (request.command === "status") {
		console.log(JSON.stringify(base));
		return;
	}

	if (request.command === "sign" && typeof request.challenge === "string") {
		console.log(
			JSON.stringify({
				...base,
				signature: `fake-signature:${request.challenge}`,
			}),
		);
		return;
	}

	console.log(JSON.stringify({ available: false, error: "unsupported-command" }));
});
