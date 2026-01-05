/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { FragmentedMediaSource, FragmentSegmentInfo } from '../fragmented-media-source';
import { Input } from '../input';
import { Mp4InputFormat } from '../input-format';
import { IsobmffDemuxer } from '../isobmff/isobmff-demuxer';
import { ReadResult, Source } from '../source';
import { createFetchHeaders, resolveUrl } from './hls-utils';
import { parsePlaylist } from './m3u8-parser';
import type { MediaPlaylist, MediaSegment } from './m3u8-types';

/**
 * Error thrown when the HLS source reaches the live edge and has no more data,
 * or when a timeout occurs while waiting for data.
 * This signals to the player that it should seek back to a safer position.
 * @group HLS
 * @public
 */
export class HlsLiveEdgeError extends Error {
	/**
	 * Whether this error was caused by a network timeout rather than actually
	 * reaching the live edge. When true, the player may want to retry rather
	 * than seek back.
	 */
	readonly isTimeout: boolean;

	/**
	 * Creates a new HlsLiveEdgeError.
	 * @param message - The error message.
	 * @param isTimeout - Whether this error was caused by a timeout.
	 */
	constructor(message: string, isTimeout = false) {
		super(message);
		this.name = 'HlsLiveEdgeError';
		this.isTimeout = isTimeout;
	}
}

/** Segment info tracked by media sequence number. */
type SegmentInfo = {
	segment: MediaSegment;
	offset: { start: number; end: number };
	mediaSequence: number;
};

/**
 * A Source that presents HLS fMP4 segments as a virtual continuous byte stream.
 * Supports live streams with playlist refresh.
 * Implements FragmentedMediaSource for segment-based fragment access in live streams.
 * @internal
 */
export class HlsSegmentSource extends Source implements FragmentedMediaSource {
	private mediaPlaylist: MediaPlaylist;
	private playlistUrl: string;
	private fetchFn: typeof fetch;

	private initSegmentData: Uint8Array | null = null;
	/** Segment data cached by media sequence number. */
	private segmentDataCache: Map<number, Uint8Array> = new Map();
	/** LRU tracking: most recently accessed segments (most recent at end). */
	private segmentAccessOrder: number[] = [];
	/** Maximum number of segments to keep in cache (default: 20 segments ~250MB for typical video). */
	private static readonly MAX_CACHED_SEGMENTS = 20;
	/** Segment info tracked by media sequence number. */
	private segmentInfoMap: Map<number, SegmentInfo> = new Map();
	/** Ordered list of media sequence numbers we know about. */
	private knownSequences: number[] = [];
	private initialized = false;

	/** For live streams: refresh timer ID. */
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	/** For live streams: whether we're currently refreshing. */
	private isRefreshing = false;
	/** Tracks the next byte offset for appending new segments. */
	private nextSegmentOffset = 0;
	/** Callback to notify when new segments are added (for updating demuxer lookup table). */
	private onSegmentsAdded:
		| ((segments: Array<{ durationSeconds: number; moofOffset: number }>, startTimeSeconds: number) => void)
		| null = null;

	/** Callback to notify when segments are removed (for cleaning up demuxer lookup table). */
	private onSegmentsRemoved: ((removedSegmentIds: number[]) => void) | null = null;

	/** Tracks total duration of all known segments for calculating new segment start times. */
	private totalDurationSeconds = 0;
	/** Counter that increments whenever segments change (for waitForNewSegments detection). */
	private segmentChangeCounter = 0;
	/** Tracks total duration of removed segments (for live stream time range calculation). */
	private removedDurationSeconds = 0;

	constructor(
		mediaPlaylist: MediaPlaylist,
		playlistUrl: string,
		fetchFn: typeof fetch,
	) {
		super();
		this.mediaPlaylist = mediaPlaylist;
		this.playlistUrl = playlistUrl;
		this.fetchFn = fetchFn;
	}

	private async initialize(): Promise<void> {
		if (this.initialized) return;

		// Find and fetch init segment
		const firstSegmentWithMap = this.mediaPlaylist.segments.find(s => s.map);
		if (!firstSegmentWithMap?.map) {
			throw new Error('HLS stream does not have an init segment (EXT-X-MAP). Only fMP4 HLS is supported.');
		}

		const initUrl = resolveUrl(firstSegmentWithMap.map.uri, this.playlistUrl);
		const initHeaders = createFetchHeaders(firstSegmentWithMap.map.byteRange);

		// 10 second timeout for init segment fetch (includes body read)
		this.initSegmentData = await this.fetchDataWithTimeout(initUrl, { headers: initHeaders }, 10000);

		// Initialize segment tracking
		this.nextSegmentOffset = this.initSegmentData.length;
		this.addSegmentsFromPlaylist(this.mediaPlaylist);

		this.initialized = true;

		// Start refresh timer for live streams
		if (!this.mediaPlaylist.endList) {
			this.startRefreshTimer();
		}
	}

	/**
	 * Adds segments from a playlist to our tracking structures.
	 * Only adds segments we don't already know about.
	 * Returns info about newly added segments for updating the demuxer lookup table,
	 * along with the start time for those new segments.
	 */
	private addSegmentsFromPlaylist(
		playlist: MediaPlaylist,
	): { newSegments: Array<{ durationSeconds: number; moofOffset: number }>; startTimeSeconds: number } {
		const baseSequence = playlist.mediaSequence;
		const newSegments: Array<{ durationSeconds: number; moofOffset: number }> = [];
		const startTimeSeconds = this.totalDurationSeconds;

		for (let i = 0; i < playlist.segments.length; i++) {
			const seq = baseSequence + i;
			const segment = playlist.segments[i]!;

			// Skip if we already have this segment
			if (this.segmentInfoMap.has(seq)) {
				continue;
			}

			// Determine start offset for this new segment
			// It should chain from the previous segment's end
			let startOffset: number;
			if (this.knownSequences.length === 0) {
				// First segment starts after init
				startOffset = this.nextSegmentOffset;
			} else {
				// Chain to the last known segment's end
				// (even if that end is unknown, it will be updated when that segment is fetched)
				const lastSeq = this.knownSequences[this.knownSequences.length - 1]!;
				const lastInfo = this.segmentInfoMap.get(lastSeq)!;
				startOffset = lastInfo.offset.end;
			}

			// Calculate end offset
			let endOffset = startOffset;
			if (segment.byteRange) {
				endOffset = startOffset + segment.byteRange.length;
			}
			// For non-byteRange segments, end = start (will be updated when fetched)

			const info: SegmentInfo = {
				segment,
				offset: {
					start: startOffset,
					end: endOffset,
				},
				mediaSequence: seq,
			};

			this.segmentInfoMap.set(seq, info);
			this.knownSequences.push(seq);

			// Track new segment for lookup table update
			newSegments.push({
				durationSeconds: segment.duration,
				moofOffset: startOffset,
			});

			// Update nextSegmentOffset and total duration
			this.nextSegmentOffset = endOffset;
			this.totalDurationSeconds += segment.duration;

			// Increment change counter for waitForNewSegments detection
			this.segmentChangeCounter++;
		}

		return { newSegments, startTimeSeconds };
	}

	/**
	 * Starts the playlist refresh timer for live streams.
	 */
	private startRefreshTimer(): void {
		if (this.refreshTimer) return;

		// Refresh at half the target duration (HLS spec recommendation)
		const refreshInterval = (this.mediaPlaylist.targetDuration / 2) * 1000;

		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.refreshPlaylist();
		}, refreshInterval);
	}

	/**
	 * Refreshes the playlist for live streams.
	 */
	private async refreshPlaylist(): Promise<void> {
		if (this.isRefreshing || this._disposed) return;
		this.isRefreshing = true;

		try {
			// 5 second timeout for playlist refresh (includes body read)
			const text = await this.fetchTextWithTimeout(this.playlistUrl, 5000);
			if (!text) {
				return;
			}

			const playlist = parsePlaylist(text);

			if (playlist.type !== 'media') {
				return;
			}

			// Update our playlist reference
			this.mediaPlaylist = playlist;

			// Remove segments that are no longer in the playlist (sliding window moved)
			this.removeExpiredSegments(playlist);

			// Add any new segments
			const { newSegments, startTimeSeconds } = this.addSegmentsFromPlaylist(playlist);

			// Notify callback so demuxer lookup table can be updated
			if (newSegments.length > 0 && this.onSegmentsAdded) {
				this.onSegmentsAdded(newSegments, startTimeSeconds);
			}

			// Pre-fetch new segments for smoother playback
			if (newSegments.length > 0) {
				void this.prefetchNewSegments();
			}

			// Schedule next refresh if still live
			if (!playlist.endList && !this._disposed) {
				this.startRefreshTimer();
			}
		} catch {
			// Retry after target duration
			if (!this._disposed) {
				this.startRefreshTimer();
			}
		} finally {
			this.isRefreshing = false;
		}
	}

	/**
	 * Removes segments that are no longer in the current playlist.
	 * This happens when the live sliding window moves forward.
	 * Keeps a large buffer of segments behind the playlist window to allow
	 * for playback that's behind the live edge (e.g., due to buffering).
	 */
	private removeExpiredSegments(playlist: MediaPlaylist): void {
		// Keep enough segments for ~15 minutes of playback behind the live edge
		// With ~12.5s segments, that's about 72 segments (~900s)
		// This gives buffer for playback that may lag behind the live edge
		const bufferSegments = 72;
		const currentMinSequence = playlist.mediaSequence - bufferSegments;
		const currentMaxSequence = playlist.mediaSequence + playlist.segments.length - 1;

		// Find sequences to remove (those before the buffer window)
		const expiredSequences = this.knownSequences.filter(
			seq => seq < currentMinSequence || seq > currentMaxSequence,
		);

		// Track removed duration for accurate time range calculation
		for (const seq of expiredSequences) {
			const info = this.segmentInfoMap.get(seq);
			if (info) {
				this.removedDurationSeconds += info.segment.duration;
			}
			this.segmentInfoMap.delete(seq);
			this.segmentDataCache.delete(seq);
			// Clean up LRU tracking
			const accessIndex = this.segmentAccessOrder.indexOf(seq);
			if (accessIndex !== -1) {
				this.segmentAccessOrder.splice(accessIndex, 1);
			}
		}

		// Notify demuxer to clean up lookup table (after removal, so we can provide IDs)
		if (expiredSequences.length > 0 && this.onSegmentsRemoved) {
			this.onSegmentsRemoved(expiredSequences);
		}

		// Update knownSequences to only include valid ones
		this.knownSequences = this.knownSequences.filter(
			seq => seq >= currentMinSequence && seq <= currentMaxSequence,
		);
	}

	/**
	 * Waits for new segments to be added (for live streams at the edge).
	 * Returns when the segment change counter increases or after a short timeout.
	 * Throws HlsLiveEdgeError if timeout occurs.
	 */
	private waitForNewSegments(): Promise<void> {
		return new Promise((resolve, reject) => {
			// Track the current change counter (handles stream loops where sequence numbers reset)
			const currentCounter = this.segmentChangeCounter;

			const checkInterval = 100; // Check every 100ms
			const maxWait = 10000; // Max wait 10 seconds for new segments
			let waited = 0;

			const check = () => {
				if (this._disposed) {
					resolve();
					return;
				}

				// Check if any new segments were added (counter incremented)
				if (this.segmentChangeCounter > currentCounter) {
					// New segment added
					resolve();
					return;
				}

				waited += checkInterval;
				if (waited >= maxWait) {
					// Timeout waiting for new segments - this could be live edge or network issue
					reject(new HlsLiveEdgeError('Reached live edge - no new segments available', true));
					return;
				}

				setTimeout(check, checkInterval);
			};

			setTimeout(check, checkInterval);
		});
	}

	/**
	 * Pre-fetches segments that aren't cached yet for smoother playback.
	 * This is called when new segments are detected in the playlist.
	 */
	private async prefetchNewSegments(): Promise<void> {
		// Prefetch any segments not yet in cache
		const segmentsToFetch = this.knownSequences.filter(
			seq => !this.segmentDataCache.has(seq),
		);

		if (segmentsToFetch.length === 0) return;

		// Fetch segments in parallel (limit concurrency to avoid overloading)
		const fetchPromises = segmentsToFetch.slice(0, 3).map(async (seq) => {
			try {
				await this.fetchSegmentBySequence(seq);
			} catch {
				// Ignore prefetch errors - segment will be fetched when needed
			}
		});

		await Promise.all(fetchPromises);
	}

	/**
	 * Fetches binary data with a timeout that covers both headers and body.
	 * Throws HlsLiveEdgeError if timeout occurs.
	 * @param url - The URL to fetch.
	 * @param options - Fetch options.
	 * @param timeoutMs - Timeout in milliseconds (default 10 seconds).
	 */
	private async fetchDataWithTimeout(
		url: string,
		options: RequestInit = {},
		timeoutMs = 10000,
	): Promise<Uint8Array> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const response = await this.fetchFn(url, {
				...options,
				signal: controller.signal,
			});

			if (!response.ok && response.status !== 206) {
				clearTimeout(timeoutId);
				throw new Error(`HTTP error ${response.status}`);
			}

			// Read the body - this is also covered by the timeout via AbortController
			const data = new Uint8Array(await response.arrayBuffer());
			clearTimeout(timeoutId);
			return data;
		} catch (error) {
			clearTimeout(timeoutId);
			if (error instanceof Error && error.name === 'AbortError') {
				throw new HlsLiveEdgeError(`Fetch timeout after ${timeoutMs}ms for ${url}`, true);
			}
			throw error;
		}
	}

	/**
	 * Fetches text with a timeout that covers both headers and body.
	 * Returns null if fetch fails (for non-critical operations like playlist refresh).
	 * @param url - The URL to fetch.
	 * @param timeoutMs - Timeout in milliseconds (default 5 seconds).
	 */
	private async fetchTextWithTimeout(
		url: string,
		timeoutMs = 5000,
	): Promise<string | null> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const response = await this.fetchFn(url, {
				signal: controller.signal,
			});

			if (!response.ok) {
				clearTimeout(timeoutId);
				return null;
			}

			// Read the body - this is also covered by the timeout via AbortController
			const text = await response.text();
			clearTimeout(timeoutId);
			return text;
		} catch {
			clearTimeout(timeoutId);
			return null;
		}
	}

	/**
	 * Fetches a segment by its media sequence number.
	 * Uses LRU cache eviction to limit memory usage.
	 */
	private async fetchSegmentBySequence(mediaSequence: number): Promise<Uint8Array> {
		const cached = this.segmentDataCache.get(mediaSequence);
		if (cached) {
			// Update LRU access order
			this.updateLruAccess(mediaSequence);
			return cached;
		}

		const info = this.segmentInfoMap.get(mediaSequence);
		if (!info) {
			throw new Error(`Segment with media sequence ${mediaSequence} not found.`);
		}

		const segmentUrl = resolveUrl(info.segment.uri, this.playlistUrl);
		const headers = createFetchHeaders(info.segment.byteRange);

		// Use timeout to prevent hanging on slow/stalled connections
		// 15 second timeout for segment fetch (includes body read)
		const data = await this.fetchDataWithTimeout(segmentUrl, { headers }, 15000);

		// Evict old cache entries if needed (before adding new one)
		this.evictOldCacheEntries();

		this.segmentDataCache.set(mediaSequence, data);
		this.segmentAccessOrder.push(mediaSequence);

		// Update offset end for this segment
		info.offset.end = info.offset.start + data.length;

		// Update subsequent segment starts (only for non-BYTERANGE streams)
		if (!info.segment.byteRange) {
			let nextStart = info.offset.end;
			const seqIndex = this.knownSequences.indexOf(mediaSequence);

			for (let i = seqIndex + 1; i < this.knownSequences.length; i++) {
				const nextSeq = this.knownSequences[i]!;
				const nextInfo = this.segmentInfoMap.get(nextSeq);
				if (!nextInfo) break;

				// Skip if next segment has BYTERANGE (already has correct offsets)
				if (nextInfo.segment.byteRange) break;

				const nextData = this.segmentDataCache.get(nextSeq);
				nextInfo.offset.start = nextStart;
				if (nextData) {
					nextInfo.offset.end = nextStart + nextData.length;
					nextStart = nextInfo.offset.end;
				} else {
					nextInfo.offset.end = nextStart; // Unknown until fetched
					break;
				}
			}
		}

		return data;
	}

	/**
	 * Updates LRU access order by moving the segment to the end.
	 */
	private updateLruAccess(mediaSequence: number): void {
		const index = this.segmentAccessOrder.indexOf(mediaSequence);
		if (index !== -1) {
			this.segmentAccessOrder.splice(index, 1);
		}
		this.segmentAccessOrder.push(mediaSequence);
	}

	/**
	 * Evicts least recently used cache entries if over the limit.
	 */
	private evictOldCacheEntries(): void {
		while (this.segmentDataCache.size >= HlsSegmentSource.MAX_CACHED_SEGMENTS) {
			// Remove the least recently used segment (first in access order)
			const lruSequence = this.segmentAccessOrder.shift();
			if (lruSequence === undefined) break;

			// Only evict if this segment is no longer in knownSequences
			// (for live streams, old segments may have been removed)
			// or if cache is significantly over limit
			if (
				!this.knownSequences.includes(lruSequence)
				|| this.segmentDataCache.size > HlsSegmentSource.MAX_CACHED_SEGMENTS
			) {
				this.segmentDataCache.delete(lruSequence);
			} else {
				// Keep it, add back to end of access order
				this.segmentAccessOrder.push(lruSequence);
				break;
			}
		}
	}

	async _retrieveSize(): Promise<number | null> {
		// For HLS, we don't know total size without fetching all segments
		// Return null to indicate unsized source
		return null;
	}

	async _read(start: number, end: number): Promise<ReadResult | null> {
		await this.initialize();

		if (!this.initSegmentData) {
			throw new Error('Not initialized.');
		}

		const requestedLength = end - start;
		const result = new Uint8Array(requestedLength);
		let bytesWritten = 0;

		// Read from init segment if needed
		const initEnd = this.initSegmentData.length;
		if (start < initEnd) {
			const copyStart = start;
			const copyEnd = Math.min(end, initEnd);
			const copyLength = copyEnd - copyStart;

			result.set(this.initSegmentData.subarray(copyStart, copyEnd), 0);
			bytesWritten += copyLength;

			if (bytesWritten >= requestedLength) {
				return {
					bytes: result,
					view: new DataView(result.buffer, result.byteOffset, result.byteLength),
					offset: start,
				};
			}
		}

		// Check if we're trying to read from a "gap" in the byte space
		// This happens when old segments were removed - there's a gap between init segment and first available segment
		if (this.knownSequences.length > 0) {
			const firstSeq = this.knownSequences[0]!;
			const firstInfo = this.segmentInfoMap.get(firstSeq);
			const currentReadStart = start + bytesWritten;

			if (firstInfo && currentReadStart < firstInfo.offset.start && currentReadStart >= initEnd) {
				// We're in the gap area between init segment and first available segment
				// For live streams, throw HlsLiveEdgeError so the player can seek to a valid position
				if (!this.mediaPlaylist.endList) {
					throw new HlsLiveEdgeError(
						`Playback fell behind live window (gap area). Read position: ${currentReadStart}, `
						+ `First available segment: ${firstInfo.offset.start}`,
					);
				}

				// For VOD streams, return what we have (shouldn't normally happen)
				if (end <= firstInfo.offset.start) {
					if (bytesWritten === 0) {
						return null;
					}
					const finalBytes = result.subarray(0, bytesWritten);
					return {
						bytes: finalBytes,
						view: new DataView(finalBytes.buffer, finalBytes.byteOffset, finalBytes.byteLength),
						offset: start,
					};
				}
			}
		}

		// Iterate through segments by media sequence number
		for (const mediaSequence of this.knownSequences) {
			// Check if we've already fetched enough
			if (bytesWritten >= requestedLength) break;

			const currentReadStart = start + bytesWritten;
			const info = this.segmentInfoMap.get(mediaSequence);
			if (!info) continue;

			const { segment, offset } = info;

			// If byteRange is present, we know the segment boundaries upfront
			if (segment.byteRange) {
				// Skip if segment is entirely before read range
				if (offset.end <= currentReadStart) {
					continue;
				}

				// Stop if segment is entirely after read range
				if (offset.start >= end) break;
			} else {
				// Without byteRange, we need to fetch segments to know their sizes
				// Check if segment size is known (offset.end > offset.start means it was fetched before)
				const sizeIsKnown = offset.end > offset.start;

				if (sizeIsKnown) {
					// Size is known (even if data was evicted from cache) - skip if entirely before read range
					if (offset.end <= currentReadStart) {
						continue;
					}
					// Stop if entirely after read range
					if (offset.start >= end) break;
				} else {
					// Segment size not known yet - check if all previous segments have known sizes
					const seqIndex = this.knownSequences.indexOf(mediaSequence);
					const allPreviousSizesKnown = this.knownSequences
						.slice(0, seqIndex)
						.every(seq => {
							const prevInfo = this.segmentInfoMap.get(seq);
							return prevInfo && prevInfo.offset.end > prevInfo.offset.start;
						});

					if (allPreviousSizesKnown) {
						// We know this segment's exact start position
						if (offset.start >= end) {
							break;
						}
					}
				}
			}

			const segmentData = await this.fetchSegmentBySequence(mediaSequence);

			// Skip if segment is entirely before read range (for non-byteRange case)
			if (offset.end <= currentReadStart) continue;

			// Stop if segment is entirely after read range
			if (offset.start >= end) break;

			// Calculate overlap
			const overlapStart = Math.max(offset.start, currentReadStart);
			const overlapEnd = Math.min(offset.end, end);
			const overlapLength = overlapEnd - overlapStart;

			if (overlapLength > 0) {
				const segmentOffset = overlapStart - offset.start;
				result.set(
					segmentData.subarray(segmentOffset, segmentOffset + overlapLength),
					bytesWritten,
				);
				bytesWritten += overlapLength;
			}
		}

		if (bytesWritten === 0) {
			if (this.knownSequences.length > 0) {
				const firstSeq = this.knownSequences[0]!;
				const lastSeq = this.knownSequences[this.knownSequences.length - 1]!;
				const firstInfo = this.segmentInfoMap.get(firstSeq);
				const lastInfo = this.segmentInfoMap.get(lastSeq);

				if (firstInfo && lastInfo) {
					// Check if requesting data that has been removed (sliding window moved past us)
					if (start < firstInfo.offset.start && !this.mediaPlaylist.endList) {
						// The requested range starts before our available data
						// This means playback has fallen behind the live sliding window
						throw new HlsLiveEdgeError(
							`Playback fell behind live window. Requested: ${start}-${end}, `
							+ `Available: ${firstInfo.offset.start}-${lastInfo.offset.end}`,
						);
					}

					// For live streams, if we're past the end of known segments, wait for new data
					const lastSegmentFetched = this.segmentDataCache.has(lastSeq);
					const lastSegmentHasByteRange = !!lastInfo.segment.byteRange;
					const lastSegmentEndKnown = lastSegmentFetched || lastSegmentHasByteRange;

					if (!this.mediaPlaylist.endList && lastSegmentEndKnown && start >= lastInfo.offset.end) {
						// We're requesting data past the last segment - wait for new segments
						await this.waitForNewSegments();
						// Retry the read after waiting
						return this._read(start, end);
					}

					// If the last segment hasn't been fetched yet and might contain data, fetch it
					if (!lastSegmentFetched && !lastSegmentHasByteRange && start >= lastInfo.offset.start) {
						await this.fetchSegmentBySequence(lastSeq);
						// Retry the read after fetching
						return this._read(start, end);
					}
				}
			}
			return null;
		}

		const finalBytes = bytesWritten < requestedLength
			? result.subarray(0, bytesWritten)
			: result;

		return {
			bytes: finalBytes,
			view: new DataView(finalBytes.buffer, finalBytes.byteOffset, finalBytes.byteLength),
			offset: start,
		};
	}

	_dispose(): void {
		// Stop refresh timer
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
			this.refreshTimer = null;
		}

		this.initSegmentData = null;
		this.segmentDataCache.clear();
		this.segmentAccessOrder = [];
		this.segmentInfoMap.clear();
		this.knownSequences = [];
	}

	/**
	 * Returns segment info for building a fragment lookup table.
	 * Must be called after initialize().
	 * @internal
	 */
	getSegmentLookupInfo(): Array<{ durationSeconds: number; moofOffset: number }> {
		if (!this.initialized) {
			throw new Error('Source must be initialized before getting segment lookup info');
		}

		return this.knownSequences.map((seq) => {
			const info = this.segmentInfoMap.get(seq)!;
			return {
				durationSeconds: info.segment.duration,
				moofOffset: info.offset.start,
			};
		});
	}

	// ==========================================
	// FragmentedMediaSource interface implementation
	// ==========================================

	/**
	 * Whether this is a live stream (no EXT-X-ENDLIST).
	 */
	get isLive(): boolean {
		return !this.mediaPlaylist.endList;
	}

	/**
	 * Returns the available time range in seconds [start, end].
	 * For VOD, this is [0, totalDuration].
	 * For live streams, this changes as the sliding window moves.
	 *
	 * Note: The time range is relative to the start of tracking (when source was initialized).
	 * For live streams, the start time increases as old segments are removed.
	 */
	getAvailableTimeRange(): { start: number; end: number } {
		if (!this.initialized || this.knownSequences.length === 0) {
			return { start: 0, end: 0 };
		}

		// For VOD streams, always return [0, totalDuration]
		if (this.mediaPlaylist.endList) {
			return { start: 0, end: this.totalDurationSeconds };
		}

		// For live streams, calculate the actual available range
		// Start = total duration of removed segments (time before first available segment)
		// End = total accumulated duration (unchanged as segments are added)
		return {
			start: this.removedDurationSeconds,
			end: this.totalDurationSeconds,
		};
	}

	/**
	 * Finds the segment containing the given timestamp.
	 * Uses binary search for efficiency.
	 * @param timeInSeconds - The timestamp to search for (in absolute time, accounting for removed segments).
	 */
	findSegmentAtTime(timeInSeconds: number): FragmentSegmentInfo | null {
		if (!this.initialized || this.knownSequences.length === 0) {
			return null;
		}

		// For live streams, time starts from removedDurationSeconds
		// For VOD, it starts from 0
		const baseTime = this.isLive ? this.removedDurationSeconds : 0;
		let cumulativeTime = baseTime;

		for (const seq of this.knownSequences) {
			const info = this.segmentInfoMap.get(seq);
			if (!info) continue;

			const segmentStartTime = cumulativeTime;
			const segmentEndTime = cumulativeTime + info.segment.duration;

			if (timeInSeconds >= segmentStartTime && timeInSeconds < segmentEndTime) {
				return {
					segmentId: seq,
					startTime: segmentStartTime,
					duration: info.segment.duration,
					hasDiscontinuity: info.segment.discontinuity,
				};
			}

			cumulativeTime = segmentEndTime;
		}

		// If time is exactly at the end, return the last segment
		if (timeInSeconds >= cumulativeTime && this.knownSequences.length > 0) {
			const lastSeq = this.knownSequences[this.knownSequences.length - 1]!;
			const lastInfo = this.segmentInfoMap.get(lastSeq);
			if (lastInfo) {
				const lastStartTime = cumulativeTime - lastInfo.segment.duration;
				return {
					segmentId: lastSeq,
					startTime: lastStartTime,
					duration: lastInfo.segment.duration,
					hasDiscontinuity: lastInfo.segment.discontinuity,
				};
			}
		}

		return null;
	}

	/**
	 * Reads raw segment data by segment ID (mediaSequence).
	 * @param segmentId - The mediaSequence number.
	 */
	async readSegmentData(segmentId: number): Promise<Uint8Array> {
		return this.fetchSegmentBySequence(segmentId);
	}

	/**
	 * Returns all currently available segments.
	 */
	getAvailableSegments(): FragmentSegmentInfo[] {
		if (!this.initialized) {
			return [];
		}

		const segments: FragmentSegmentInfo[] = [];
		// For live streams, time starts from removedDurationSeconds
		// For VOD, it starts from 0
		const baseTime = this.isLive ? this.removedDurationSeconds : 0;
		let cumulativeTime = baseTime;

		for (const seq of this.knownSequences) {
			const info = this.segmentInfoMap.get(seq);
			if (!info) continue;

			// Only include byteOffset if the segment has been fetched (has accurate size)
			const isFetched = this.segmentDataCache.has(seq);
			const hasByteRange = !!info.segment.byteRange;

			segments.push({
				segmentId: seq,
				startTime: cumulativeTime,
				duration: info.segment.duration,
				// Include byte offset only if we know it's accurate
				byteOffset: (isFetched || hasByteRange) ? info.offset.start : undefined,
				hasDiscontinuity: info.segment.discontinuity,
			});

			cumulativeTime += info.segment.duration;
		}

		return segments;
	}

	/**
	 * Gets the byte offset for a specific segment ID.
	 * More efficient than getAvailableSegments() when you only need one segment's offset.
	 * @param segmentId - The mediaSequence number.
	 * @returns The byte offset, or undefined if segment not found or not fetched yet.
	 */
	getSegmentByteOffset(segmentId: number): number | undefined {
		const info = this.segmentInfoMap.get(segmentId);
		if (!info) return undefined;

		// Only return offset if we know it's accurate
		const isFetched = this.segmentDataCache.has(segmentId);
		const hasByteRange = !!info.segment.byteRange;

		if (isFetched || hasByteRange) {
			return info.offset.start;
		}

		return undefined;
	}

	/**
	 * Gets the expected start time for a segment in cumulative HLS time.
	 * This is used to adjust timestamps for segments after discontinuities.
	 * @param segmentId - The mediaSequence number.
	 * @returns The expected start time in seconds, or undefined if segment not found.
	 */
	getSegmentExpectedStartTime(segmentId: number): number | undefined {
		if (!this.initialized) return undefined;

		// Calculate cumulative time up to this segment
		const baseTime = this.isLive ? this.removedDurationSeconds : 0;
		let cumulativeTime = baseTime;

		for (const seq of this.knownSequences) {
			if (seq === segmentId) {
				return cumulativeTime;
			}
			const info = this.segmentInfoMap.get(seq);
			if (info) {
				cumulativeTime += info.segment.duration;
			}
		}

		return undefined;
	}

	/**
	 * Returns the init segment data.
	 * Required for segment-based playback to construct valid fMP4.
	 * @internal
	 */
	getInitSegmentData(): Uint8Array | null {
		return this.initSegmentData;
	}

	/**
	 * Ensures the source is initialized.
	 * @internal
	 */
	async ensureInitialized(): Promise<void> {
		await this.initialize();
	}

	/**
	 * Sets a callback to be notified when new segments are added.
	 * Used by HlsVariantInput to update the demuxer's fragment lookup table.
	 * @internal
	 */
	setOnSegmentsAdded(
		callback: (
			segments: Array<{ durationSeconds: number; moofOffset: number }>,
			startTimeSeconds: number,
		) => void,
	): void {
		this.onSegmentsAdded = callback;
	}

	/**
	 * Sets a callback to be notified when segments are removed.
	 * Used by HlsVariantInput to clean up the demuxer's fragment lookup table.
	 * @param callback - Function that receives the removed segment IDs (mediaSequence numbers).
	 * @internal
	 */
	setOnSegmentsRemoved(callback: (removedSegmentIds: number[]) => void): void {
		this.onSegmentsRemoved = callback;
	}

	/**
	 * Returns the current total duration of all known segments in seconds.
	 * For live streams, this grows as new segments are added.
	 * @internal
	 */
	getTotalDurationSeconds(): number {
		return this.totalDurationSeconds;
	}
}

/**
 * An Input that wraps an HLS media playlist's fMP4 segments.
 * This is an internal class used by HlsInput.
 * @internal
 */
export class HlsVariantInput extends Input<HlsSegmentSource> {
	constructor(
		mediaPlaylist: MediaPlaylist,
		baseUrl: string,
		fetchFn: typeof fetch,
	) {
		const source = new HlsSegmentSource(mediaPlaylist, baseUrl, fetchFn);

		super({
			source,
			formats: [new Mp4InputFormat()],
		});
	}

	/**
	 * Returns the current total duration of all known segments in seconds.
	 * For live streams, this grows as new segments are added.
	 * @internal
	 */
	async getLiveDuration(): Promise<number> {
		await this._source.ensureInitialized();
		return this._source.getTotalDurationSeconds();
	}

	/**
	 * Override _getDemuxer to normalize timestamps and populate fragment lookup table
	 * for efficient HLS seeking.
	 *
	 * HLS streams may have non-zero baseMediaDecodeTime (tfdt), which would cause
	 * playback to start at a non-zero time. This normalizes timestamps to start at 0.
	 *
	 * Additionally, HLS streams don't have an mfra (movie fragment random access) box,
	 * so we populate the fragment lookup table from HLS segment durations to enable
	 * efficient seeking without scanning all moof boxes.
	 *
	 * @internal
	 */
	override _getDemuxer() {
		return this._demuxerPromise ??= (async () => {
			// Ensure HLS source is initialized (fetches init segment and builds segment offsets)
			await this._source.ensureInitialized();

			// Replicate parent implementation to create the demuxer
			this._reader.fileSize = await this._source.getSizeOrNull();

			let demuxer = null;
			for (const format of this._formats) {
				const canRead = await format._canReadInput(this);
				if (canRead) {
					this._format = format;
					demuxer = format._createDemuxer(this);
					break;
				}
			}

			if (!demuxer) {
				throw new Error('Input has an unsupported or unrecognizable format.');
			}

			// For ISOBMFF demuxer, normalize timestamps and populate fragment lookup table
			if (demuxer instanceof IsobmffDemuxer) {
				// Read metadata first to get track timescales
				await demuxer.readMetadata();

				// Populate fragment lookup table from HLS segment info
				// This enables efficient seeking without scanning all moof boxes
				const segmentInfo = this._source.getSegmentLookupInfo();
				demuxer.populateFragmentLookupTableFromSegments(segmentInfo);

				// Normalize start timestamp for HLS
				await demuxer.normalizeStartTimestamp();

				// Adjust lookup table timestamps to match normalized internal timestamps
				// This must be done AFTER normalization since editListOffset changes
				demuxer.adjustFragmentLookupTableForEditListOffset();

				// Set up callback to update demuxer when new segments are added (live streams)
				this._source.setOnSegmentsAdded((segments, startTimeSeconds) => {
					demuxer.appendFragmentsToLookupTable(segments, startTimeSeconds);
				});

				// Set up callback to clean up demuxer when segments are removed (live streams)
				this._source.setOnSegmentsRemoved((removedSegmentIds) => {
					demuxer.removeOldFragmentsFromLookupTable(removedSegmentIds);
				});

				// For live streams, enable segment-based lookup to handle sliding window
				// This is necessary because byte offsets become invalid when old segments are removed
				if (this._source.isLive) {
					demuxer.setFragmentedSource(this._source);
				}
			}

			return demuxer;
		})();
	}
}
