export interface ArtifactUpdateEvent {
	type: "artifact_updated";
	sessionId: string;
	filename: string;
	timestamp: number;
}

type Subscriber = (event: ArtifactUpdateEvent) => void;

const subscribersBySession = new Map<string, Set<Subscriber>>();

export function publishArtifactUpdate(
	sessionId: string,
	filename: string,
): void {
	const subs = subscribersBySession.get(sessionId);
	if (!subs || subs.size === 0) return;
	const event: ArtifactUpdateEvent = {
		type: "artifact_updated",
		sessionId,
		filename,
		timestamp: Date.now(),
	};
	for (const sub of subs) {
		try {
			sub(event);
		} catch {
			// ignore subscriber errors
		}
	}
}

export function subscribeArtifactUpdates(
	sessionId: string,
	subscriber: Subscriber,
): () => void {
	let set = subscribersBySession.get(sessionId);
	if (!set) {
		set = new Set<Subscriber>();
		subscribersBySession.set(sessionId, set);
	}
	set.add(subscriber);

	return () => {
		const current = subscribersBySession.get(sessionId);
		if (!current) return;
		current.delete(subscriber);
		if (current.size === 0) {
			subscribersBySession.delete(sessionId);
		}
	};
}
