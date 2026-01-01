/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { IsobmffMuxer } from '../isobmff/isobmff-muxer';
import { Muxer } from '../muxer';
import { Output, OutputAudioTrack, OutputSubtitleTrack, OutputVideoTrack } from '../output';
import { Mp4OutputFormat } from '../output-format';
import { EncodedPacket } from '../packet';
import { SubtitleCue, SubtitleMetadata } from '../subtitles';
import { NullTarget } from '../target';
import { HlsOutputFormat } from './hls-output-format';
import { HlsTarget } from './hls-target';
import type { HlsSegmentInfo } from './hls-types';
import type { MediaPlaylist, MediaSegment } from './m3u8-types';
import { writeMediaPlaylist } from './m3u8-writer';

/**
 * Muxer for HLS output using fMP4 segments.
 * @internal
 */
export class HlsMuxer extends Muxer {
	private format: HlsOutputFormat;
	private hlsTarget: HlsTarget;

	// Use composition: internal IsobmffMuxer for generating fMP4 data
	private internalMuxer: IsobmffMuxer;

	// Segment tracking
	private initSegment: Uint8Array | null = null;
	private segments: HlsSegmentInfo[] = [];
	private currentSegmentNumber = 0;
	private currentSegmentTimestamp = 0;
	private currentSegmentData: Uint8Array[] = [];

	constructor(output: Output, format: HlsOutputFormat) {
		super(output);
		this.format = format;

		// Validate that the target is an HlsTarget
		if (!(output.target instanceof HlsTarget)) {
			throw new Error('HlsOutputFormat requires an HlsTarget.');
		}
		this.hlsTarget = output.target;

		// Create internal format for fMP4 generation with callbacks
		const mp4Format = new Mp4OutputFormat({
			fastStart: 'fragmented',
			minimumFragmentDuration: format._options.segmentDuration,
			onFtyp: (data: Uint8Array) => this.handleFtyp(data),
			onMoov: (data: Uint8Array) => this.handleMoov(data),
			onMoof: (data: Uint8Array, _position: number, timestamp: number) => this.handleMoof(data, timestamp),
			onMdat: (data: Uint8Array) => this.handleMdat(data),
		});

		// Create the internal muxer directly
		// We use a dummy output just to satisfy the muxer constructor
		const dummyOutput = new Output({
			target: new NullTarget(),
			format: mp4Format,
		});
		this.internalMuxer = dummyOutput['_muxer'] as IsobmffMuxer;

		// Override the internal muxer's output reference to our actual output
		// so it can access our tracks
		this.internalMuxer.output = output;
	}

	private handleFtyp(data: Uint8Array) {
		// ftyp is part of the init segment
		if (!this.initSegment) {
			this.initSegment = data;
		} else {
			const combined = new Uint8Array(this.initSegment.length + data.length);
			combined.set(this.initSegment);
			combined.set(data, this.initSegment.length);
			this.initSegment = combined;
		}
	}

	private handleMoov(data: Uint8Array) {
		// moov is part of the init segment (ftyp + moov)
		if (!this.initSegment) {
			this.initSegment = data;
		} else {
			const combined = new Uint8Array(this.initSegment.length + data.length);
			combined.set(this.initSegment);
			combined.set(data, this.initSegment.length);
			this.initSegment = combined;
		}

		// Write init segment to target
		this.hlsTarget._writeInitSegment(
			this.format._options.initSegmentFileName,
			this.initSegment,
		);
	}

	private handleMoof(data: Uint8Array, timestamp: number) {
		// Check if we should finalize the previous segment
		if (this.currentSegmentData.length > 0) {
			this.finalizeCurrentSegment(timestamp);
		}

		// Start new segment
		this.currentSegmentTimestamp = timestamp;
		this.currentSegmentData.push(data);
	}

	private handleMdat(data: Uint8Array) {
		// mdat follows moof in fragmented MP4
		this.currentSegmentData.push(data);
	}

	private finalizeCurrentSegment(nextTimestamp?: number) {
		if (this.currentSegmentData.length === 0) return;

		// Combine all data for this segment
		const totalSize = this.currentSegmentData.reduce((sum, d) => sum + d.length, 0);
		const segmentData = new Uint8Array(totalSize);
		let offset = 0;
		for (const chunk of this.currentSegmentData) {
			segmentData.set(chunk, offset);
			offset += chunk.length;
		}

		// Calculate duration
		const duration = nextTimestamp !== undefined
			? nextTimestamp - this.currentSegmentTimestamp
			: this.format._options.segmentDuration;

		const fileName = this.format._options.segmentFilePattern
			.replace('{number}', String(this.currentSegmentNumber));

		const segmentInfo: HlsSegmentInfo = {
			number: this.currentSegmentNumber,
			timestamp: this.currentSegmentTimestamp,
			duration: Math.max(duration, 0.001), // Ensure positive duration
			fileName,
			data: segmentData,
		};

		this.segments.push(segmentInfo);

		// Write segment to target
		this.hlsTarget._writeSegment(segmentInfo);

		// For live streams, remove old segments
		if (!this.format._options.playlistType && this.segments.length > this.format._options.maxSegmentCount) {
			const removedSegment = this.segments.shift()!;
			this.hlsTarget._removeSegment(removedSegment.fileName);
		}

		// Update playlist
		this.updatePlaylist(false);

		this.currentSegmentNumber++;
		this.currentSegmentData = [];
	}

	private updatePlaylist(isFinalized: boolean) {
		const playlist = this.buildPlaylist(isFinalized);
		const playlistContent = writeMediaPlaylist(playlist);
		this.hlsTarget._writePlaylist(this.format._options.playlistFileName, playlistContent);
	}

	private buildPlaylist(isFinalized: boolean): MediaPlaylist {
		const targetDuration = Math.ceil(
			Math.max(this.format._options.segmentDuration, ...this.segments.map(s => s.duration)),
		);

		const segments: MediaSegment[] = this.segments.map((seg, index) => ({
			duration: seg.duration,
			uri: seg.fileName,
			// Only set map on first segment - it applies until changed
			map: index === 0 ? { uri: this.format._options.initSegmentFileName } : undefined,
		}));

		const mediaSequence = this.format._options.playlistType
			? 0
			: Math.max(0, this.currentSegmentNumber - this.segments.length);

		return {
			type: 'media',
			version: 6, // Required for fMP4
			targetDuration,
			mediaSequence,
			playlistType: this.format._options.playlistType,
			endList: isFinalized && this.format._options.playlistType === 'VOD',
			segments,
		};
	}

	async start(): Promise<void> {
		await this.internalMuxer.start();
	}

	async getMimeType(): Promise<string> {
		return 'application/vnd.apple.mpegurl';
	}

	async addEncodedVideoPacket(
		track: OutputVideoTrack,
		packet: EncodedPacket,
		meta?: EncodedVideoChunkMetadata,
	): Promise<void> {
		await this.internalMuxer.addEncodedVideoPacket(track, packet, meta);
	}

	async addEncodedAudioPacket(
		track: OutputAudioTrack,
		packet: EncodedPacket,
		meta?: EncodedAudioChunkMetadata,
	): Promise<void> {
		await this.internalMuxer.addEncodedAudioPacket(track, packet, meta);
	}

	async addSubtitleCue(
		track: OutputSubtitleTrack,
		cue: SubtitleCue,
		meta?: SubtitleMetadata,
	): Promise<void> {
		await this.internalMuxer.addSubtitleCue(track, cue, meta);
	}

	async finalize(): Promise<void> {
		// Finalize internal muxer to flush remaining data
		await this.internalMuxer.finalize();

		// Finalize any remaining segment
		this.finalizeCurrentSegment();

		// Write final playlist
		this.updatePlaylist(true);

		// Notify target that we're done
		this.hlsTarget._finalize();
	}
}
