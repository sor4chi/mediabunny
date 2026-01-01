/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Input } from '../input';
import { MP4 } from '../input-format';
import { InputAudioTrack, InputVideoTrack } from '../input-track';
import { EncodedPacketSink } from '../media-sink';
import { EncodedPacket } from '../packet';
import { BufferSource } from '../source';
import { HlsSource } from './hls-source';
import type { MediaPlaylist, MediaRendition, MediaSegment } from './m3u8-types';

/**
 * Information about a segment's position in the stream.
 * @internal
 */
export type SegmentInfo = {
	/** Index of the segment in the playlist. */
	index: number;
	/** The segment metadata from the playlist. */
	segment: MediaSegment;
	/** Start time of the segment in seconds. */
	startTime: number;
	/** End time of the segment in seconds. */
	endTime: number;
};

/**
 * Cached segment data and its demuxer.
 * @internal
 */
type CachedSegment = {
	info: SegmentInfo;
	data: Uint8Array;
	input: Input;
	videoTrack: InputVideoTrack | null;
	audioTrack: InputAudioTrack | null;
};

/**
 * Reads HLS segments individually, treating each segment as an independent fMP4 file.
 * This avoids the issue of scanning all moof boxes by processing segments one at a time.
 * Supports both video segments and separate audio renditions.
 * @internal
 */
export class HlsSegmentReader {
	private hlsSource: HlsSource;
	private initSegment: Uint8Array | null = null;
	private segmentInfos: SegmentInfo[] = [];
	private cachedSegments: Map<number, CachedSegment> = new Map();
	private maxCachedSegments: number;
	private prefetchingSegments: Set<number> = new Set();

	// Audio rendition support
	private _audioRenditionPlaylist: MediaPlaylist | null = null;
	private audioInitSegment: Uint8Array | null = null;
	private audioSegmentInfos: SegmentInfo[] = [];
	private cachedAudioSegments: Map<number, CachedSegment> = new Map();
	private hasAudioRendition = false;
	private prefetchingAudioSegments: Set<number> = new Set();

	constructor(hlsSource: HlsSource, options: { maxCachedSegments?: number } = {}) {
		this.hlsSource = hlsSource;
		this.maxCachedSegments = options.maxCachedSegments ?? 5;
	}

	/**
	 * Initializes the reader by fetching the init segment and building the segment index.
	 */
	async initialize(): Promise<void> {
		// Resolve the stream if not already done
		const resolvedStream = await this.hlsSource.resolve();

		// Fetch the init segment for video
		this.initSegment = await this.hlsSource.fetchInitSegment();
		if (!this.initSegment) {
			throw new Error('HLS stream does not have an init segment (fMP4 required).');
		}

		// Build segment index from playlist (video)
		let currentTime = 0;
		for (let i = 0; i < resolvedStream.mediaPlaylist.segments.length; i++) {
			const segment = resolvedStream.mediaPlaylist.segments[i]!;
			this.segmentInfos.push({
				index: i,
				segment,
				startTime: currentTime,
				endTime: currentTime + segment.duration,
			});
			currentTime += segment.duration;
		}

		// Check for separate audio rendition
		const audioRendition = this.hlsSource.getDefaultAudioRendition();
		if (audioRendition) {
			await this.initializeAudioRendition(audioRendition);
		}
	}

	/**
	 * Initializes the audio rendition playlist and segments.
	 */
	private async initializeAudioRendition(rendition: MediaRendition): Promise<void> {
		const playlist = await this.hlsSource.fetchAudioRenditionPlaylist(rendition);
		if (!playlist) {
			return;
		}

		this._audioRenditionPlaylist = playlist;

		// Fetch audio init segment
		this.audioInitSegment = await this.hlsSource.fetchAudioRenditionInitSegment(playlist);
		if (!this.audioInitSegment) {
			return;
		}

		// Build audio segment index
		let currentTime = 0;
		for (let i = 0; i < playlist.segments.length; i++) {
			const segment = playlist.segments[i]!;
			this.audioSegmentInfos.push({
				index: i,
				segment,
				startTime: currentTime,
				endTime: currentTime + segment.duration,
			});
			currentTime += segment.duration;
		}

		this.hasAudioRendition = true;
	}

	/**
	 * Returns whether this stream has a separate audio rendition.
	 */
	hasAudioInSeparateRendition(): boolean {
		return this.hasAudioRendition;
	}

	/**
	 * Returns the total duration of the stream in seconds.
	 */
	getTotalDuration(): number {
		if (this.segmentInfos.length === 0) return 0;
		return this.segmentInfos[this.segmentInfos.length - 1]!.endTime;
	}

	/**
	 * Returns the number of segments in the stream.
	 */
	getSegmentCount(): number {
		return this.segmentInfos.length;
	}

	/**
	 * Returns the number of audio segments.
	 */
	getAudioSegmentCount(): number {
		return this.hasAudioRendition ? this.audioSegmentInfos.length : this.segmentInfos.length;
	}

	/**
	 * Returns segment info for a given index.
	 */
	getSegmentInfo(index: number): SegmentInfo | null {
		return this.segmentInfos[index] ?? null;
	}

	/**
	 * Returns audio segment info for a given index.
	 */
	getAudioSegmentInfo(index: number): SegmentInfo | null {
		if (this.hasAudioRendition) {
			return this.audioSegmentInfos[index] ?? null;
		}
		return this.segmentInfos[index] ?? null;
	}

	/**
	 * Finds the segment that contains the given timestamp.
	 */
	findSegmentForTime(timestamp: number): SegmentInfo | null {
		return this.binarySearchSegment(this.segmentInfos, timestamp);
	}

	/**
	 * Finds the audio segment that contains the given timestamp.
	 */
	findAudioSegmentForTime(timestamp: number): SegmentInfo | null {
		if (this.hasAudioRendition) {
			return this.binarySearchSegment(this.audioSegmentInfos, timestamp);
		}
		return this.binarySearchSegment(this.segmentInfos, timestamp);
	}

	private binarySearchSegment(segments: SegmentInfo[], timestamp: number): SegmentInfo | null {
		let left = 0;
		let right = segments.length - 1;

		while (left <= right) {
			const mid = Math.floor((left + right) / 2);
			const info = segments[mid]!;

			if (timestamp < info.startTime) {
				right = mid - 1;
			} else if (timestamp >= info.endTime) {
				left = mid + 1;
			} else {
				return info;
			}
		}

		// If not found, return the last segment if timestamp is at or after it
		if (segments.length > 0 && timestamp >= segments[segments.length - 1]!.startTime) {
			return segments[segments.length - 1]!;
		}

		return null;
	}

	/**
	 * Loads a video segment and creates an Input for it.
	 */
	async loadSegment(index: number): Promise<CachedSegment> {
		const cached = await this.loadSegmentInternal(index);

		// Prefetch next segment in background (only from public loadSegment, not from prefetch)
		this.prefetchSegment(index + 1);

		return cached;
	}

	/**
	 * Internal method to load a segment without triggering additional prefetch.
	 */
	private async loadSegmentInternal(index: number): Promise<CachedSegment> {
		// Check cache first
		const cached = this.cachedSegments.get(index);
		if (cached) {
			return cached;
		}

		const info = this.segmentInfos[index];
		if (!info) {
			throw new Error(`Segment index ${index} out of range.`);
		}
		if (!this.initSegment) {
			throw new Error('Reader not initialized.');
		}

		// Fetch the segment data
		const segmentData = await this.hlsSource.fetchSegment(info.segment.uri, info.segment.byteRange);

		// Combine init segment + media segment
		const combinedData = new Uint8Array(this.initSegment.length + segmentData.length);
		combinedData.set(this.initSegment, 0);
		combinedData.set(segmentData, this.initSegment.length);

		// Create an Input for this combined data
		const source = new BufferSource(combinedData.buffer);
		const input = new Input({
			source,
			formats: [MP4],
		});

		// Get tracks
		const videoTrack = await input.getPrimaryVideoTrack();
		const audioTrack = await input.getPrimaryAudioTrack();

		const cachedSegment: CachedSegment = {
			info,
			data: combinedData,
			input,
			videoTrack,
			audioTrack,
		};

		// Add to cache
		this.cachedSegments.set(index, cachedSegment);

		// Evict old segments if needed
		this.evictOldSegments(this.cachedSegments, index);

		return cachedSegment;
	}

	/**
	 * Prefetches a video segment in the background.
	 */
	private prefetchSegment(index: number): void {
		if (index >= this.segmentInfos.length) {
			return; // Out of range
		}
		if (this.cachedSegments.has(index)) {
			return; // Already cached
		}
		if (this.prefetchingSegments.has(index)) {
			return; // Already prefetching
		}

		this.prefetchingSegments.add(index);
		// Use loadSegmentInternal to avoid triggering another prefetch chain
		void this.loadSegmentInternal(index).then(() => {
			this.prefetchingSegments.delete(index);
		}).catch(() => {
			// Prefetch errors are intentionally ignored - the actual load will report errors
			this.prefetchingSegments.delete(index);
		});
	}

	/**
	 * Loads an audio rendition segment and creates an Input for it.
	 */
	async loadAudioSegment(index: number): Promise<CachedSegment> {
		if (!this.hasAudioRendition) {
			// No separate audio rendition, use video segment
			return this.loadSegment(index);
		}

		const cached = await this.loadAudioSegmentInternal(index);

		// Prefetch next segment in background (only from public loadAudioSegment, not from prefetch)
		this.prefetchAudioSegment(index + 1);

		return cached;
	}

	/**
	 * Internal method to load an audio segment without triggering additional prefetch.
	 */
	private async loadAudioSegmentInternal(index: number): Promise<CachedSegment> {
		// Check cache first
		const cached = this.cachedAudioSegments.get(index);
		if (cached) {
			return cached;
		}

		const info = this.audioSegmentInfos[index];
		if (!info) {
			throw new Error(`Audio segment index ${index} out of range.`);
		}
		if (!this.audioInitSegment) {
			throw new Error('Audio rendition not initialized.');
		}

		// Fetch the segment data
		const segmentData = await this.hlsSource.fetchAudioRenditionSegment(
			info.segment.uri,
			info.segment.byteRange,
		);

		// Combine init segment + media segment
		const combinedData = new Uint8Array(this.audioInitSegment.length + segmentData.length);
		combinedData.set(this.audioInitSegment, 0);
		combinedData.set(segmentData, this.audioInitSegment.length);

		// Create an Input for this combined data
		const source = new BufferSource(combinedData.buffer);
		const input = new Input({
			source,
			formats: [MP4],
		});

		// Get tracks
		const videoTrack = await input.getPrimaryVideoTrack();
		const audioTrack = await input.getPrimaryAudioTrack();

		const cachedSegment: CachedSegment = {
			info,
			data: combinedData,
			input,
			videoTrack,
			audioTrack,
		};

		// Add to cache
		this.cachedAudioSegments.set(index, cachedSegment);

		// Evict old segments if needed
		this.evictOldSegments(this.cachedAudioSegments, index);

		return cachedSegment;
	}

	/**
	 * Prefetches an audio segment in the background.
	 */
	private prefetchAudioSegment(index: number): void {
		if (!this.hasAudioRendition) {
			return;
		}
		if (index >= this.audioSegmentInfos.length) {
			return; // Out of range
		}
		if (this.cachedAudioSegments.has(index)) {
			return; // Already cached
		}
		if (this.prefetchingAudioSegments.has(index)) {
			return; // Already prefetching
		}

		this.prefetchingAudioSegments.add(index);
		// Use loadAudioSegmentInternal to avoid triggering another prefetch chain
		void this.loadAudioSegmentInternal(index).then(() => {
			this.prefetchingAudioSegments.delete(index);
		}).catch(() => {
			// Prefetch errors are intentionally ignored - the actual load will report errors
			this.prefetchingAudioSegments.delete(index);
		});
	}

	/**
	 * Yields all video packets from a segment, with timestamps adjusted to stream time (in seconds).
	 */
	async* getVideoPackets(
		segmentIndex: number,
		startTime?: number,
	): AsyncGenerator<EncodedPacket, void, unknown> {
		const segment = await this.loadSegment(segmentIndex);
		if (!segment.videoTrack) return;

		const packetSink = new EncodedPacketSink(segment.videoTrack);

		// Get the expected start time from the HLS playlist
		const segmentInfo = this.segmentInfos[segmentIndex];
		const playlistStartTime = segmentInfo?.startTime ?? 0;

		// Determine the timestamp offset by looking at the first packet's timestamp
		// fMP4 segments may have baseMediaDecodeTime that doesn't match the playlist timing
		let timestampOffset: number | null = null;

		// Get starting packet (startTime is in seconds)
		let startPacket: EncodedPacket | undefined;
		if (startTime !== undefined) {
			const keyPacket = await packetSink.getKeyPacket(startTime);
			startPacket = keyPacket ?? undefined;
		}

		for await (const packet of packetSink.packets(startPacket)) {
			// Calculate the offset from the first packet
			if (timestampOffset === null) {
				timestampOffset = packet.timestamp - playlistStartTime;
			}

			// Adjust the timestamp to match the HLS playlist timing using clone()
			yield packet.clone({ timestamp: packet.timestamp - timestampOffset });
		}
	}

	/**
	 * Yields all audio packets from a segment, with timestamps adjusted to stream time (in seconds).
	 * If there's a separate audio rendition, uses that; otherwise uses audio from video segment.
	 */
	async* getAudioPackets(
		segmentIndex: number,
		startTime?: number,
	): AsyncGenerator<EncodedPacket, void, unknown> {
		const segment = await this.loadAudioSegment(segmentIndex);
		if (!segment.audioTrack) return;

		const packetSink = new EncodedPacketSink(segment.audioTrack);

		// Get the expected start time from the HLS playlist (audio or video)
		const segmentInfos = this.hasAudioRendition ? this.audioSegmentInfos : this.segmentInfos;
		const segmentInfo = segmentInfos[segmentIndex];
		const playlistStartTime = segmentInfo?.startTime ?? 0;

		// Determine the timestamp offset by looking at the first packet's timestamp
		// fMP4 segments may have baseMediaDecodeTime that doesn't match the playlist timing
		let timestampOffset: number | null = null;

		// Get starting packet (startTime is in seconds)
		let startPacket: EncodedPacket | undefined;
		if (startTime !== undefined) {
			const keyPacket = await packetSink.getKeyPacket(startTime);
			startPacket = keyPacket ?? undefined;
		}

		for await (const packet of packetSink.packets(startPacket)) {
			// Calculate the offset from the first packet
			if (timestampOffset === null) {
				timestampOffset = packet.timestamp - playlistStartTime;
			}

			// Adjust the timestamp to match the HLS playlist timing using clone()
			yield packet.clone({ timestamp: packet.timestamp - timestampOffset });
		}
	}

	/**
	 * Gets track info from the first segment.
	 * This is used to determine codec info, dimensions, etc.
	 */
	async getTrackInfo(): Promise<{
		videoTrack: InputVideoTrack | null;
		audioTrack: InputAudioTrack | null;
	}> {
		if (this.segmentInfos.length === 0) {
			return { videoTrack: null, audioTrack: null };
		}

		const segment = await this.loadSegment(0);
		let audioTrack = segment.audioTrack;

		// If audio is in a separate rendition, get the audio track from there
		if (this.hasAudioRendition && this.audioSegmentInfos.length > 0) {
			const audioSegment = await this.loadAudioSegment(0);
			audioTrack = audioSegment.audioTrack;
		}

		return {
			videoTrack: segment.videoTrack,
			audioTrack,
		};
	}

	/**
	 * Evicts old segments from the cache to free memory.
	 */
	private evictOldSegments(cache: Map<number, CachedSegment>, currentIndex: number): void {
		if (cache.size <= this.maxCachedSegments) {
			return;
		}

		// Find segments to evict (keep segments close to current)
		const keepRange = Math.floor(this.maxCachedSegments / 2);
		const minKeep = Math.max(0, currentIndex - keepRange);
		const maxKeep = currentIndex + keepRange;

		for (const [index, cached] of cache) {
			if (index < minKeep || index > maxKeep) {
				// Dispose the input
				cached.input[Symbol.dispose]();
				cache.delete(index);
			}

			if (cache.size <= this.maxCachedSegments) {
				break;
			}
		}
	}

	/**
	 * Disposes of all cached segments and resources.
	 */
	dispose(): void {
		for (const [, cached] of this.cachedSegments) {
			cached.input[Symbol.dispose]();
		}
		this.cachedSegments.clear();

		for (const [, cached] of this.cachedAudioSegments) {
			cached.input[Symbol.dispose]();
		}
		this.cachedAudioSegments.clear();

		this.initSegment = null;
		this.audioInitSegment = null;
		this.segmentInfos = [];
		this.audioSegmentInfos = [];
	}
}
