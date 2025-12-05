/**
 * Generic event stream class for async iteration with result extraction.
 *
 * This provides a clean abstraction for streaming events where you need both:
 * 1. Async iteration over individual events
 * 2. A promise that resolves to the final result when streaming completes
 *
 * @example
 * const stream = new EventStream(
 *   (event) => event.type === 'done',
 *   (event) => event.finalData
 * );
 *
 * // Producer pushes events
 * stream.push({ type: 'data', value: 1 });
 * stream.push({ type: 'data', value: 2 });
 * stream.push({ type: 'done', finalData: { total: 3 } });
 *
 * // Consumer iterates
 * for await (const event of stream) {
 *   console.log(event);
 * }
 *
 * // Or get the final result directly
 * const result = await stream.result();
 */
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	private done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;

	constructor(
		private isComplete: (event: T) => boolean,
		private extractResult: (event: T) => R,
	) {
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	/**
	 * Push an event to the stream.
	 * If the event is complete (as determined by isComplete), the stream ends.
	 */
	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	/**
	 * End the stream, optionally providing a final result.
	 */
	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.resolveFinalResult(result);
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift();
			if (waiter) {
				waiter({ value: undefined as T, done: true });
			}
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift() as T;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) =>
					this.waiting.push(resolve),
				);
				if (result.done) return;
				yield result.value;
			}
		}
	}

	/**
	 * Get a promise that resolves to the final result when streaming completes.
	 */
	result(): Promise<R> {
		return this.finalResultPromise;
	}
}
