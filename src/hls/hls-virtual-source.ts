/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { ReadResult, Source } from '../source';
import { HlsSource, HlsResolvedStream } from './hls-source';
import type { MediaSegment } from './m3u8-types';

type SegmentRange = {
	segment: MediaSegment;
	/** The start offset in the virtual file. */
	virtualStart: number;
	/** The end offset in the virtual file (exclusive). */
	virtualEnd: number;
	/** Cached data for this segment. */
	data: Uint8Array | null;
};

/**
 * Options for {@link HlsVirtualSource}.
 * @group Input sources
 * @public
 */
export type HlsVirtualSourceOptions = {
	/**
	 * Maximum number of segment data to keep in memory cache.
	 * Older segments will be evicted when this limit is reached.
	 * Defaults to 3.
	 */
	maxCachedSegments?: number;
};

/**
 * A source that wraps an {@link HlsSource} and presents HLS segments as a virtual byte stream.
 * This allows HLS streams to be read using the standard {@link Input} API.
 *
 * The virtual byte stream is constructed as: init segment + segment0 + segment1 + ...
 *
 * @example
 * ```typescript
 * import { Input, HlsSource, HlsVirtualSource, HLS_INPUT } from 'mediabunny';
 *
 * const hlsSource = new HlsSource('https://example.com/stream.m3u8');
 * const virtualSource = new HlsVirtualSource(hlsSource);
 *
 * const input = new Input({
 *   source: virtualSource,
 *   formats: [HLS_INPUT],
 * });
 *
 * const videoTrack = await input.getPrimaryVideoTrack();
 * ```
 *
 * @group Input sources
 * @public
 */
export class HlsVirtualSource extends Source {
	/** @internal */
	readonly _isHlsVirtualSource = true;

	/** @internal */
	private hlsSource: HlsSource;
	/** @internal */
	private options: Required<HlsVirtualSourceOptions>;
	/** @internal */
	private resolvedStream: HlsResolvedStream | null = null;
	/** @internal */
	private initSegmentData: Uint8Array | null = null;
	/** @internal */
	private segmentRanges: SegmentRange[] = [];
	/** @internal */
	private virtualSize: number | null = null;
	/** @internal */
	private initialized = false;
	/** @internal */
	private initPromise: Promise<void> | null = null;

	/**
	 * Creates a new {@link HlsVirtualSource} that wraps the specified {@link HlsSource}.
	 * @param hlsSource - The HLS source to wrap.
	 * @param options - Configuration options.
	 */
	constructor(hlsSource: HlsSource, options: HlsVirtualSourceOptions = {}) {
		if (!(hlsSource instanceof HlsSource)) {
			throw new TypeError('hlsSource must be an HlsSource.');
		}
		if (options && typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}

		super();

		this.hlsSource = hlsSource;
		this.options = {
			maxCachedSegments: options.maxCachedSegments ?? 3,
		};
	}

	/**
	 * Returns the underlying {@link HlsSource}.
	 */
	getHlsSource(): HlsSource {
		return this.hlsSource;
	}

	/** @internal */
	private async initialize(): Promise<void> {
		if (this.initialized) return;
		if (this.initPromise) return this.initPromise;

		this.initPromise = (async () => {
			// Resolve the HLS stream
			this.resolvedStream = await this.hlsSource.resolve();

			// Fetch the init segment
			const initSegmentData = await this.hlsSource.fetchInitSegment();
			if (!initSegmentData) {
				throw new Error('HLS stream does not have an init segment (fMP4 required).');
			}
			this.initSegmentData = initSegmentData;

			// Build segment ranges
			let currentOffset = initSegmentData.length;
			const segments = this.resolvedStream.mediaPlaylist.segments;

			for (const segment of segments) {
				// We don't know the actual segment size until we fetch it.
				// For now, we'll use a placeholder and update when we fetch.
				this.segmentRanges.push({
					segment,
					virtualStart: currentOffset,
					virtualEnd: currentOffset, // Will be updated when segment is fetched
					data: null,
				});

				currentOffset += 0; // Will be updated as segments are fetched
			}

			this.initialized = true;
		})();

		return this.initPromise;
	}

	/** @internal */
	async _retrieveSize(): Promise<number | null> {
		await this.initialize();

		// For HLS, we need to fetch all segments to know the total size.
		// This is expensive, so we'll return null (unsized) for now.
		// The demuxer will handle this by reading sequentially.
		if (this.virtualSize !== null) {
			return this.virtualSize;
		}

		// For VOD streams, we could potentially calculate size by fetching all segments
		// But this would be slow, so we return null for now
		return null;
	}

	/** @internal */
	async _read(start: number, end: number): Promise<ReadResult | null> {
		await this.initialize();

		if (!this.initSegmentData) {
			throw new Error('HLS stream not initialized.');
		}

		const requestedLength = end - start;
		const bytes = new Uint8Array(requestedLength);
		let bytesWritten = 0;

		// Check if we're reading from the init segment
		const initSegmentEnd = this.initSegmentData.length;
		if (start < initSegmentEnd) {
			const copyStart = start;
			const copyEnd = Math.min(end, initSegmentEnd);
			const copyLength = copyEnd - copyStart;

			bytes.set(
				this.initSegmentData.subarray(copyStart, copyEnd),
				0,
			);
			bytesWritten += copyLength;

			if (bytesWritten >= requestedLength) {
				return {
					bytes,
					view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
					offset: start,
				};
			}
		}

		// Read from segments
		let currentVirtualPos = initSegmentEnd;

		for (let i = 0; i < this.segmentRanges.length; i++) {
			const range = this.segmentRanges[i]!;

			// Fetch segment if not cached
			if (range.data === null) {
				const segmentData = await this.hlsSource.fetchSegment(range.segment.uri, range.segment.byteRange);
				range.data = segmentData;
				range.virtualStart = currentVirtualPos;
				range.virtualEnd = currentVirtualPos + segmentData.length;

				// Update subsequent ranges
				let nextOffset = range.virtualEnd;
				for (let j = i + 1; j < this.segmentRanges.length; j++) {
					const nextRange = this.segmentRanges[j]!;
					if (nextRange.data !== null) {
						nextRange.virtualStart = nextOffset;
						nextRange.virtualEnd = nextOffset + nextRange.data.length;
						nextOffset = nextRange.virtualEnd;
					} else {
						break;
					}
				}

				// Evict old segments to save memory
				this.evictOldSegments(i);
			}

			currentVirtualPos = range.virtualEnd;

			// Check if this segment overlaps with the requested range
			const readStart = start + bytesWritten;
			const readEnd = end;

			if (range.virtualStart >= readEnd) {
				// Past the requested range
				break;
			}

			if (range.virtualEnd <= readStart) {
				// Before the requested range
				continue;
			}

			// Calculate overlap
			const overlapStart = Math.max(range.virtualStart, readStart);
			const overlapEnd = Math.min(range.virtualEnd, readEnd);
			const overlapLength = overlapEnd - overlapStart;

			if (overlapLength > 0 && range.data) {
				const segmentOffset = overlapStart - range.virtualStart;
				bytes.set(
					range.data.subarray(segmentOffset, segmentOffset + overlapLength),
					bytesWritten,
				);
				bytesWritten += overlapLength;

				if (bytesWritten >= requestedLength) {
					break;
				}
			}
		}

		if (bytesWritten === 0) {
			return null;
		}

		// Return only the bytes we actually read
		const resultBytes = bytesWritten < requestedLength
			? bytes.subarray(0, bytesWritten)
			: bytes;

		return {
			bytes: resultBytes,
			view: new DataView(resultBytes.buffer, resultBytes.byteOffset, resultBytes.byteLength),
			offset: start,
		};
	}

	/** @internal */
	private evictOldSegments(currentIndex: number): void {
		const maxCached = this.options.maxCachedSegments;
		let cachedCount = 0;

		// Count cached segments and evict old ones
		for (let i = this.segmentRanges.length - 1; i >= 0; i--) {
			const range = this.segmentRanges[i]!;
			if (range.data !== null) {
				cachedCount++;
				if (cachedCount > maxCached && i < currentIndex - 1) {
					// Evict this segment, but keep virtual positions
					range.data = null;
				}
			}
		}
	}

	/** @internal */
	_dispose(): void {
		this.hlsSource.dispose();
		this.initSegmentData = null;
		this.segmentRanges = [];
		this.resolvedStream = null;
	}
}

/**
 * Creates an {@link HlsVirtualSource} from the specified HLS manifest URL.
 * This is a convenience function that creates both the {@link HlsSource} and {@link HlsVirtualSource}.
 *
 * @example
 * ```typescript
 * import { Input, createHlsVirtualSource, HLS_INPUT } from 'mediabunny';
 *
 * const source = createHlsVirtualSource('https://example.com/stream.m3u8', {
 *   qualitySelection: 'highest',
 * });
 *
 * const input = new Input({
 *   source,
 *   formats: [HLS_INPUT],
 * });
 * ```
 *
 * @group Input sources
 * @public
 */
export const createHlsVirtualSource = (
	manifestUrl: string,
	options: import('./hls-source').HlsSourceOptions & HlsVirtualSourceOptions = {},
): HlsVirtualSource => {
	const hlsSource = new HlsSource(manifestUrl, options);
	return new HlsVirtualSource(hlsSource, options);
};
