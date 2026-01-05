/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Input } from '../input';
import { Mp4InputFormat } from '../input-format';
import { IsobmffDemuxer } from '../isobmff/isobmff-demuxer';
import { ReadResult, Source } from '../source';
import { createFetchHeaders, resolveUrl } from './hls-utils';
import { parsePlaylist } from './m3u8-parser';
import type { MediaPlaylist, MediaSegment } from './m3u8-types';

/** Segment info tracked by media sequence number. */
type SegmentInfo = {
	segment: MediaSegment;
	offset: { start: number; end: number };
	mediaSequence: number;
};

/**
 * A Source that presents HLS fMP4 segments as a virtual continuous byte stream.
 * Supports live streams with playlist refresh.
 * @internal
 */
export class HlsSegmentSource extends Source {
	private mediaPlaylist: MediaPlaylist;
	private playlistUrl: string;
	private fetchFn: typeof fetch;

	private initSegmentData: Uint8Array | null = null;
	/** Segment data cached by media sequence number. */
	private segmentDataCache: Map<number, Uint8Array> = new Map();
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

	/** Tracks total duration of all known segments for calculating new segment start times. */
	private totalDurationSeconds = 0;

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

		const initResponse = await this.fetchFn(initUrl, { headers: initHeaders });
		if (!initResponse.ok && initResponse.status !== 206) {
			throw new Error(`Failed to fetch init segment: ${initResponse.status}`);
		}
		this.initSegmentData = new Uint8Array(await initResponse.arrayBuffer());

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
			const response = await this.fetchFn(this.playlistUrl);
			if (!response.ok) {
				console.warn(`Failed to refresh HLS playlist: ${response.status}`);
				return;
			}

			const text = await response.text();
			const playlist = parsePlaylist(text);

			if (playlist.type !== 'media') {
				console.warn('Expected media playlist but got master playlist during refresh');
				return;
			}

			// Update our playlist reference
			this.mediaPlaylist = playlist;

			// Add any new segments
			const { newSegments, startTimeSeconds } = this.addSegmentsFromPlaylist(playlist);

			// Notify callback so demuxer lookup table can be updated
			if (newSegments.length > 0 && this.onSegmentsAdded) {
				this.onSegmentsAdded(newSegments, startTimeSeconds);
			}

			// Evict old segment data from cache (keep last 10 sequences)
			this.evictOldSegments();

			// Schedule next refresh if still live
			if (!playlist.endList && !this._disposed) {
				this.startRefreshTimer();
			}
		} catch (error) {
			console.warn('Error refreshing HLS playlist:', error);
			// Retry after target duration
			if (!this._disposed) {
				this.startRefreshTimer();
			}
		} finally {
			this.isRefreshing = false;
		}
	}

	/**
	 * Evicts old segment data from cache to save memory.
	 */
	private evictOldSegments(): void {
		const maxCached = 10;
		if (this.segmentDataCache.size <= maxCached) return;

		const sortedKeys = [...this.segmentDataCache.keys()].sort((a, b) => a - b);
		const toRemove = sortedKeys.slice(0, sortedKeys.length - maxCached);

		for (const key of toRemove) {
			this.segmentDataCache.delete(key);
		}
	}

	/**
	 * Fetches a segment by its media sequence number.
	 */
	private async fetchSegmentBySequence(mediaSequence: number): Promise<Uint8Array> {
		const cached = this.segmentDataCache.get(mediaSequence);
		if (cached) {
			return cached;
		}

		const info = this.segmentInfoMap.get(mediaSequence);
		if (!info) {
			throw new Error(`Segment with media sequence ${mediaSequence} not found.`);
		}

		const segmentUrl = resolveUrl(info.segment.uri, this.playlistUrl);
		const headers = createFetchHeaders(info.segment.byteRange);

		const response = await this.fetchFn(segmentUrl, { headers });
		if (!response.ok && response.status !== 206) {
			throw new Error(`Failed to fetch segment ${mediaSequence}: ${response.status}`);
		}

		const data = new Uint8Array(await response.arrayBuffer());
		this.segmentDataCache.set(mediaSequence, data);

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

		// Evict old segments to save memory
		this.evictOldSegments();

		return data;
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
				// We can only skip a segment if we've already fetched it AND know its range doesn't overlap
				if (this.segmentDataCache.has(mediaSequence)) {
					// Segment already fetched, we know its bounds - skip if entirely before read range
					if (offset.end <= currentReadStart) {
						continue;
					}
					// Stop if entirely after read range
					if (offset.start >= end) break;
				} else {
					// Segment not fetched yet - check if all previous segments are fetched
					const seqIndex = this.knownSequences.indexOf(mediaSequence);
					const allPreviousFetched = this.knownSequences
						.slice(0, seqIndex)
						.every(seq => this.segmentDataCache.has(seq));

					if (allPreviousFetched) {
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
			}

			return demuxer;
		})();
	}
}
