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
import type { MediaPlaylist } from './m3u8-types';

/**
 * A Source that presents HLS fMP4 segments as a virtual continuous byte stream.
 * @internal
 */
export class HlsSegmentSource extends Source {
	private mediaPlaylist: MediaPlaylist;
	private baseUrl: string;
	private fetchFn: typeof fetch;

	private initSegmentData: Uint8Array | null = null;
	private segmentDataCache: Map<number, Uint8Array> = new Map();
	private segmentOffsets: { start: number; end: number }[] = [];
	private initialized = false;

	constructor(
		mediaPlaylist: MediaPlaylist,
		baseUrl: string,
		fetchFn: typeof fetch,
	) {
		super();
		this.mediaPlaylist = mediaPlaylist;
		this.baseUrl = baseUrl;
		this.fetchFn = fetchFn;
	}

	private async initialize(): Promise<void> {
		if (this.initialized) return;

		// Find and fetch init segment
		const firstSegmentWithMap = this.mediaPlaylist.segments.find(s => s.map);
		if (!firstSegmentWithMap?.map) {
			throw new Error('HLS stream does not have an init segment (EXT-X-MAP). Only fMP4 HLS is supported.');
		}

		const initUrl = resolveUrl(firstSegmentWithMap.map.uri, this.baseUrl);
		const initHeaders = createFetchHeaders(firstSegmentWithMap.map.byteRange);

		const initResponse = await this.fetchFn(initUrl, { headers: initHeaders });
		if (!initResponse.ok && initResponse.status !== 206) {
			throw new Error(`Failed to fetch init segment: ${initResponse.status}`);
		}
		this.initSegmentData = new Uint8Array(await initResponse.arrayBuffer());

		// Build segment offset map
		// If segments have byteRange, we know sizes upfront; otherwise we need to fetch to know
		const initLength = this.initSegmentData.length;
		let currentOffset = initLength;

		for (let i = 0; i < this.mediaPlaylist.segments.length; i++) {
			const seg = this.mediaPlaylist.segments[i]!;
			if (seg.byteRange) {
				// Size is known from manifest
				const segmentSize = seg.byteRange.length;
				this.segmentOffsets.push({
					start: currentOffset,
					end: currentOffset + segmentSize,
				});
				currentOffset += segmentSize;
			} else {
				// Size unknown until fetched
				this.segmentOffsets.push({
					start: currentOffset,
					end: currentOffset, // Will be updated when fetched
				});
			}
		}

		this.initialized = true;
	}

	private async fetchSegment(index: number): Promise<Uint8Array> {
		const cached = this.segmentDataCache.get(index);
		if (cached) {
			return cached;
		}

		const segment = this.mediaPlaylist.segments[index];
		if (!segment) {
			throw new Error(`Segment ${index} not found.`);
		}

		const segmentUrl = resolveUrl(segment.uri, this.baseUrl);
		const headers = createFetchHeaders(segment.byteRange);

		const response = await this.fetchFn(segmentUrl, { headers });
		if (!response.ok && response.status !== 206) {
			throw new Error(`Failed to fetch segment ${index}: ${response.status}`);
		}

		const data = new Uint8Array(await response.arrayBuffer());
		this.segmentDataCache.set(index, data);

		// Update offsets for this and subsequent segments
		const offset = this.segmentOffsets[index]!;
		offset.end = offset.start + data.length;

		// Update subsequent segment starts (only for non-BYTERANGE streams)
		// For BYTERANGE streams, offsets are already correctly calculated in initialize()
		const seg = this.mediaPlaylist.segments[index]!;
		if (!seg.byteRange) {
			let nextStart = offset.end;
			for (let i = index + 1; i < this.segmentOffsets.length; i++) {
				const nextOffset = this.segmentOffsets[i]!;
				const nextSeg = this.mediaPlaylist.segments[i]!;
				// Skip if next segment has BYTERANGE (already has correct offsets)
				if (nextSeg.byteRange) break;

				const nextData = this.segmentDataCache.get(i);
				nextOffset.start = nextStart;
				if (nextData) {
					nextOffset.end = nextStart + nextData.length;
					nextStart = nextOffset.end;
				} else {
					nextOffset.end = nextStart; // Unknown until fetched
					break;
				}
			}
		}

		// Evict old segments to save memory (keep max 5)
		if (this.segmentDataCache.size > 5) {
			const keys = [...this.segmentDataCache.keys()].sort((a, b) => a - b);
			for (const key of keys) {
				if (key < index - 2) {
					this.segmentDataCache.delete(key);
				}
				if (this.segmentDataCache.size <= 5) break;
			}
		}

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

		for (let i = 0; i < this.mediaPlaylist.segments.length; i++) {
			// Check if we've already fetched enough
			if (bytesWritten >= requestedLength) break;

			const currentReadStart = start + bytesWritten;
			const seg = this.mediaPlaylist.segments[i]!;
			const offset = this.segmentOffsets[i]!;

			// If byteRange is present, we know the segment boundaries upfront
			if (seg.byteRange) {
				// Skip if segment is entirely before read range
				if (offset.end <= currentReadStart) {
					continue;
				}

				// Stop if segment is entirely after read range
				if (offset.start >= end) break;
			} else {
				// Without byteRange, we need to fetch segments to know their sizes
				// We can only skip a segment if we've already fetched it AND know its range doesn't overlap
				if (this.segmentDataCache.has(i)) {
					// Segment already fetched, we know its bounds - skip if entirely before read range
					if (offset.end <= currentReadStart) {
						continue;
					}
					// Stop if entirely after read range
					if (offset.start >= end) break;
				} else if (i > 0) {
					// Segment not fetched yet - check if all previous segments are fetched
					// so we know the exact start position of this segment
					const allPreviousFetched = Array.from(
						{ length: i },
						(_, j) => this.segmentDataCache.has(j),
					).every(Boolean);
					if (allPreviousFetched) {
						// We know this segment's exact start position
						// Skip only if we're before this segment's start
						// (We must fetch to know the end)
						if (offset.start >= end) {
							break;
						}
						// If currentReadStart >= offset.start, we need this segment
						// If currentReadStart < offset.start, this segment hasn't started yet at our read position
						// But we still can't skip because we don't know the end
					}
				}
			}

			const segmentData = await this.fetchSegment(i);

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
		this.initSegmentData = null;
		this.segmentDataCache.clear();
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

		return this.mediaPlaylist.segments.map((segment, index) => ({
			durationSeconds: segment.duration,
			moofOffset: this.segmentOffsets[index]!.start,
		}));
	}

	/**
	 * Ensures the source is initialized.
	 * @internal
	 */
	async ensureInitialized(): Promise<void> {
		await this.initialize();
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
			}

			return demuxer;
		})();
	}
}
