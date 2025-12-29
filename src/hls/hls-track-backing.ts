/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AudioCodec, VideoCodec } from '../codec';
import { InputAudioTrackBacking, InputVideoTrackBacking } from '../input-track';
import { PacketRetrievalOptions } from '../media-sink';
import { TrackDisposition } from '../metadata';
import { Rotation } from '../misc';
import { EncodedPacket } from '../packet';
import { HlsSegmentReader } from './hls-segment-reader';

/**
 * Cached segment packets for a specific segment.
 * @internal
 */
type SegmentPacketCache = {
	segmentIndex: number;
	packets: EncodedPacket[];
};

/**
 * Base class for HLS track backings that delegates packet retrieval to HlsSegmentReader.
 * This provides cross-segment packet iteration by loading segments on-demand.
 * @internal
 */
abstract class HlsTrackBacking {
	protected segmentReader: HlsSegmentReader;
	protected trackId: number;

	// Segment-based packet cache (only cache a few segments at a time)
	private segmentCache: Map<number, SegmentPacketCache> = new Map();
	private maxCachedSegments = 5;
	private prefetchingSegments: Set<number> = new Set();

	constructor(segmentReader: HlsSegmentReader, trackId: number) {
		this.segmentReader = segmentReader;
		this.trackId = trackId;
	}

	getId(): number {
		return this.trackId;
	}

	abstract getCodec(): AudioCodec | VideoCodec | null;

	getInternalCodecId(): string | number | Uint8Array | null {
		return null;
	}

	getName(): string | null {
		return null;
	}

	getLanguageCode(): string {
		return 'und';
	}

	getTimeResolution(): number {
		return 90000; // Common HLS timescale
	}

	getDisposition(): TrackDisposition {
		return {
			default: true,
			forced: false,
			original: false,
			commentary: false,
			hearingImpaired: false,
			visuallyImpaired: false,
		};
	}

	async getFirstTimestamp(): Promise<number> {
		const firstSegment = this.segmentReader.getSegmentInfo(0);
		return firstSegment?.startTime ?? 0;
	}

	async computeDuration(): Promise<number> {
		return this.segmentReader.getTotalDuration();
	}

	/**
	 * Gets packets from the segment reader. This must be implemented by subclasses.
	 */
	protected abstract getPacketsFromSegment(
		segmentIndex: number,
		startTime?: number,
	): AsyncGenerator<EncodedPacket, void, unknown>;

	/**
	 * Loads packets from a specific segment into cache.
	 */
	private async loadSegmentPackets(segmentIndex: number): Promise<SegmentPacketCache> {
		// Check cache first
		const cached = this.segmentCache.get(segmentIndex);
		if (cached) {
			// Prefetch next segment in background
			this.prefetchNextSegment(segmentIndex);
			return cached;
		}

		// Load packets from the segment
		const packets: EncodedPacket[] = [];
		for await (const packet of this.getPacketsFromSegment(segmentIndex)) {
			packets.push(packet);
		}

		// Sort by sequenceNumber (DTS order) for proper decode order
		// Note: Do NOT sort by timestamp (PTS) as B-frames have earlier PTS than
		// their reference P-frames, but must be decoded after them
		packets.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

		const cache: SegmentPacketCache = { segmentIndex, packets };
		this.segmentCache.set(segmentIndex, cache);

		// Evict old segments if needed
		this.evictOldSegments(segmentIndex);

		// Prefetch next segment in background
		this.prefetchNextSegment(segmentIndex);

		return cache;
	}

	/**
	 * Prefetches the next segment in background to avoid stalls.
	 */
	private prefetchNextSegment(currentIndex: number): void {
		const nextIndex = currentIndex + 1;
		if (nextIndex >= this.getSegmentCountForTrack()) {
			return; // No more segments
		}
		if (this.segmentCache.has(nextIndex)) {
			return; // Already cached
		}
		if (this.prefetchingSegments.has(nextIndex)) {
			return; // Already prefetching
		}

		// Start prefetching in background
		this.prefetchingSegments.add(nextIndex);
		void this.loadSegmentPacketsInternal(nextIndex).then(() => {
			this.prefetchingSegments.delete(nextIndex);
		}).catch(() => {
			// Prefetch errors are intentionally ignored - the actual load will report errors
			this.prefetchingSegments.delete(nextIndex);
		});
	}

	/**
	 * Internal method to load segment packets without triggering additional prefetch.
	 */
	private async loadSegmentPacketsInternal(segmentIndex: number): Promise<SegmentPacketCache> {
		// Check cache first
		const cached = this.segmentCache.get(segmentIndex);
		if (cached) {
			return cached;
		}

		// Load packets from the segment
		const packets: EncodedPacket[] = [];
		for await (const packet of this.getPacketsFromSegment(segmentIndex)) {
			packets.push(packet);
		}

		// Sort by sequenceNumber (DTS order) for proper decode order
		packets.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

		const cache: SegmentPacketCache = { segmentIndex, packets };
		this.segmentCache.set(segmentIndex, cache);

		// Evict old segments if needed
		this.evictOldSegments(segmentIndex);

		return cache;
	}

	/**
	 * Evicts old segments from cache to save memory.
	 */
	private evictOldSegments(currentIndex: number): void {
		if (this.segmentCache.size <= this.maxCachedSegments) {
			return;
		}

		const keepRange = Math.floor(this.maxCachedSegments / 2);
		const minKeep = Math.max(0, currentIndex - keepRange);
		const maxKeep = currentIndex + keepRange;

		for (const [index] of this.segmentCache) {
			if (index < minKeep || index > maxKeep) {
				this.segmentCache.delete(index);
			}

			if (this.segmentCache.size <= this.maxCachedSegments) {
				break;
			}
		}
	}

	/**
	 * Finds the segment index containing a timestamp (in seconds).
	 * Subclasses can override for audio segment lookup.
	 */
	protected findSegmentForTimestamp(timestampInSeconds: number): number {
		const segmentInfo = this.segmentReader.findSegmentForTime(timestampInSeconds);
		return segmentInfo?.index ?? 0;
	}

	/**
	 * Returns the total segment count.
	 * Subclasses can override to use audio segment count.
	 */
	protected getSegmentCountForTrack(): number {
		return this.segmentReader.getSegmentCount();
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async getFirstPacket(options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		const cache = await this.loadSegmentPackets(0);
		return cache.packets[0] ?? null;
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async getPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		// timestamp is in seconds, packet.timestamp is also in seconds
		const segmentIndex = this.findSegmentForTimestamp(timestamp);
		const cache = await this.loadSegmentPackets(segmentIndex);

		if (cache.packets.length === 0) return null;

		// Binary search within the segment (both in seconds)
		let left = 0;
		let right = cache.packets.length - 1;
		let result = -1;

		while (left <= right) {
			const mid = Math.floor((left + right) / 2);
			const packet = cache.packets[mid]!;

			if (packet.timestamp <= timestamp) {
				result = mid;
				left = mid + 1;
			} else {
				right = mid - 1;
			}
		}

		if (result === -1) return null;
		return cache.packets[result] ?? null;
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async getNextPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		// packet.timestamp is in seconds
		let segmentIndex = this.findSegmentForTimestamp(packet.timestamp);
		let cache = await this.loadSegmentPackets(segmentIndex);

		// Find the current packet in the segment by timestamp (more reliable than sequenceNumber across segments)
		// Use a small epsilon for floating point comparison
		const epsilon = 0.0001;
		let currentIndex = cache.packets.findIndex(
			p => Math.abs(p.timestamp - packet.timestamp) < epsilon,
		);

		// If packet not found in this segment, it might be at the boundary
		// Try the next segment
		if (currentIndex === -1) {
			const nextSegmentIndex = segmentIndex + 1;
			if (nextSegmentIndex >= this.getSegmentCountForTrack()) {
				return null; // End of stream
			}
			cache = await this.loadSegmentPackets(nextSegmentIndex);
			currentIndex = cache.packets.findIndex(
				p => Math.abs(p.timestamp - packet.timestamp) < epsilon,
			);
			if (currentIndex === -1) {
				// Still not found, return first packet of next segment
				return cache.packets[0] ?? null;
			}
			segmentIndex = nextSegmentIndex;
		}

		if (currentIndex < cache.packets.length - 1) {
			// Next packet is in the same segment
			return cache.packets[currentIndex + 1] ?? null;
		}

		// Need to get the first packet from the next segment
		const nextSegmentIndex = segmentIndex + 1;
		if (nextSegmentIndex >= this.getSegmentCountForTrack()) {
			return null; // End of stream
		}

		cache = await this.loadSegmentPackets(nextSegmentIndex);
		return cache.packets[0] ?? null;
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async getKeyPacket(timestamp: number, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		// timestamp is in seconds, packet.timestamp is also in seconds
		let segmentIndex = this.findSegmentForTimestamp(timestamp);

		// Search backwards through segments until we find a key packet
		while (segmentIndex >= 0) {
			const cache = await this.loadSegmentPackets(segmentIndex);

			// Find the packet at or before the timestamp
			let searchIndex = cache.packets.length - 1;
			if (segmentIndex === this.findSegmentForTimestamp(timestamp)) {
				// In the target segment, find packet at timestamp first
				for (let i = cache.packets.length - 1; i >= 0; i--) {
					if (cache.packets[i]!.timestamp <= timestamp) {
						searchIndex = i;
						break;
					}
				}
			}

			// Walk backwards to find a key packet
			for (let i = searchIndex; i >= 0; i--) {
				const p = cache.packets[i]!;
				if (p.type === 'key') {
					return p;
				}
			}

			// No key packet in this segment, check previous segment
			segmentIndex--;
		}

		return null;
	}

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	async getNextKeyPacket(packet: EncodedPacket, options: PacketRetrievalOptions): Promise<EncodedPacket | null> {
		// packet.timestamp is in seconds
		let segmentIndex = this.findSegmentForTimestamp(packet.timestamp);
		const segmentCount = this.getSegmentCountForTrack();

		// Find starting position in current segment by timestamp
		const epsilon = 0.0001;
		let cache = await this.loadSegmentPackets(segmentIndex);
		let startIndex = cache.packets.findIndex(
			p => Math.abs(p.timestamp - packet.timestamp) < epsilon,
		);
		if (startIndex === -1) startIndex = 0;

		// Search forward through segments
		while (segmentIndex < segmentCount) {
			cache = await this.loadSegmentPackets(segmentIndex);

			for (let i = startIndex + 1; i < cache.packets.length; i++) {
				const p = cache.packets[i]!;
				if (p.type === 'key') {
					return p;
				}
			}

			// Move to next segment
			segmentIndex++;
			startIndex = -1; // Start from beginning of next segment
		}

		return null;
	}
}

/**
 * HLS video track backing implementation.
 * @internal
 */
export class HlsVideoTrackBacking extends HlsTrackBacking implements InputVideoTrackBacking {
	private videoCodec: VideoCodec | null;
	private width: number;
	private height: number;
	private rotation: Rotation;
	private colorSpace: VideoColorSpaceInit;
	private decoderConfig: VideoDecoderConfig | null;
	private timeResolutionValue: number;

	constructor(
		segmentReader: HlsSegmentReader,
		trackId: number,
		videoCodec: VideoCodec | null,
		width: number,
		height: number,
		rotation: Rotation,
		colorSpace: VideoColorSpaceInit,
		decoderConfig: VideoDecoderConfig | null,
		timeResolution: number,
	) {
		super(segmentReader, trackId);
		this.videoCodec = videoCodec;
		this.width = width;
		this.height = height;
		this.rotation = rotation;
		this.colorSpace = colorSpace;
		this.decoderConfig = decoderConfig;
		this.timeResolutionValue = timeResolution;
	}

	override getTimeResolution(): number {
		return this.timeResolutionValue;
	}

	getCodec(): VideoCodec | null {
		return this.videoCodec;
	}

	getCodedWidth(): number {
		return this.width;
	}

	getCodedHeight(): number {
		return this.height;
	}

	getRotation(): Rotation {
		return this.rotation;
	}

	async getColorSpace(): Promise<VideoColorSpaceInit> {
		return this.colorSpace;
	}

	async canBeTransparent(): Promise<boolean> {
		return false;
	}

	async getDecoderConfig(): Promise<VideoDecoderConfig | null> {
		return this.decoderConfig;
	}

	protected getPacketsFromSegment(
		segmentIndex: number,
		startTime?: number,
	): AsyncGenerator<EncodedPacket, void, unknown> {
		return this.segmentReader.getVideoPackets(segmentIndex, startTime);
	}

	protected override findSegmentForTimestamp(timestampInSeconds: number): number {
		const segmentInfo = this.segmentReader.findSegmentForTime(timestampInSeconds);
		return segmentInfo?.index ?? 0;
	}
}

/**
 * HLS audio track backing implementation.
 * @internal
 */
export class HlsAudioTrackBacking extends HlsTrackBacking implements InputAudioTrackBacking {
	private audioCodec: AudioCodec | null;
	private numberOfChannels: number;
	private sampleRate: number;
	private decoderConfig: AudioDecoderConfig | null;
	private timeResolutionValue: number;

	constructor(
		segmentReader: HlsSegmentReader,
		trackId: number,
		audioCodec: AudioCodec | null,
		numberOfChannels: number,
		sampleRate: number,
		decoderConfig: AudioDecoderConfig | null,
		timeResolution: number,
	) {
		super(segmentReader, trackId);
		this.audioCodec = audioCodec;
		this.numberOfChannels = numberOfChannels;
		this.sampleRate = sampleRate;
		this.decoderConfig = decoderConfig;
		this.timeResolutionValue = timeResolution;
	}

	override getTimeResolution(): number {
		return this.timeResolutionValue;
	}

	getCodec(): AudioCodec | null {
		return this.audioCodec;
	}

	getNumberOfChannels(): number {
		return this.numberOfChannels;
	}

	getSampleRate(): number {
		return this.sampleRate;
	}

	async getDecoderConfig(): Promise<AudioDecoderConfig | null> {
		return this.decoderConfig;
	}

	protected getPacketsFromSegment(
		segmentIndex: number,
		startTime?: number,
	): AsyncGenerator<EncodedPacket, void, unknown> {
		return this.segmentReader.getAudioPackets(segmentIndex, startTime);
	}

	protected override findSegmentForTimestamp(timestampInSeconds: number): number {
		const segmentInfo = this.segmentReader.findAudioSegmentForTime(timestampInSeconds);
		return segmentInfo?.index ?? 0;
	}

	protected override getSegmentCountForTrack(): number {
		return this.segmentReader.getAudioSegmentCount();
	}
}
