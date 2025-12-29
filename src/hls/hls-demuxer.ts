/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { InputAudioTrack, InputTrack, InputVideoTrack } from '../input-track';
import { IsobmffDemuxer } from '../isobmff/isobmff-demuxer';
import { MetadataTags } from '../metadata';
import { HlsSegmentReader } from './hls-segment-reader';
import { HlsSource } from './hls-source';
import { HlsAudioTrackBacking, HlsVideoTrackBacking } from './hls-track-backing';
import { HlsVirtualSource } from './hls-virtual-source';

/**
 * Demuxer for HLS streams backed by fMP4 segments.
 * This demuxer uses HlsSegmentReader to process segments individually,
 * avoiding the performance issues of scanning all moof boxes.
 * @internal
 */
export class HlsDemuxer extends Demuxer {
	private _isobmffDemuxer: IsobmffDemuxer | null = null;
	private segmentReader: HlsSegmentReader | null = null;
	private hlsSource: HlsSource | null = null;
	private tracks: InputTrack[] | null = null;
	private initialized = false;
	private initPromise: Promise<void> | null = null;

	constructor(input: Input) {
		super(input);

		// Check if we have an HLS source
		const source = input._source;
		if (source instanceof HlsVirtualSource) {
			this.hlsSource = source.getHlsSource();
		}
		// Note: IsobmffDemuxer is lazily initialized only when needed (non-HLS fallback)
	}

	/**
	 * Gets the ISOBMFF demuxer, creating it lazily if needed.
	 * Only used as fallback when not using HLS source.
	 */
	private get isobmffDemuxer(): IsobmffDemuxer {
		if (!this._isobmffDemuxer) {
			this._isobmffDemuxer = new IsobmffDemuxer(this.input);
		}
		return this._isobmffDemuxer;
	}

	/**
	 * Initializes the HLS segment reader if using an HLS source.
	 */
	private async initialize(): Promise<void> {
		if (this.initialized) return;
		if (this.initPromise) return this.initPromise;

		this.initPromise = (async () => {
			if (this.hlsSource) {
				this.segmentReader = new HlsSegmentReader(this.hlsSource);
				await this.segmentReader.initialize();
			}
			this.initialized = true;
		})();

		return this.initPromise;
	}

	async computeDuration(): Promise<number> {
		await this.initialize();

		// For HLS, compute duration from the segment reader
		if (this.segmentReader) {
			const hlsSource = this.hlsSource!;
			const resolvedStream = await hlsSource.resolve();

			// For live streams, duration is unknown
			if (resolvedStream.isLive) {
				return Infinity;
			}

			return this.segmentReader.getTotalDuration();
		}

		// Fallback to ISOBMFF demuxer for non-HLS sources
		return this.isobmffDemuxer.computeDuration();
	}

	async getTracks(): Promise<InputTrack[]> {
		await this.initialize();

		// Return cached tracks if available
		if (this.tracks) {
			return this.tracks;
		}

		// For HLS, create tracks using the segment reader
		if (this.segmentReader) {
			const trackInfo = await this.segmentReader.getTrackInfo();
			const tracks: InputTrack[] = [];

			if (trackInfo.videoTrack) {
				const sourceTrack = trackInfo.videoTrack;
				const decoderConfig = await sourceTrack.getDecoderConfig();
				const colorSpace = await sourceTrack._backing.getColorSpace();

				const videoTrackBacking = new HlsVideoTrackBacking(
					this.segmentReader,
					sourceTrack.id,
					sourceTrack.codec,
					sourceTrack.codedWidth,
					sourceTrack.codedHeight,
					sourceTrack.rotation,
					colorSpace,
					decoderConfig,
					sourceTrack.timeResolution,
				);

				tracks.push(new InputVideoTrack(this.input, videoTrackBacking));
			}

			if (trackInfo.audioTrack) {
				const sourceTrack = trackInfo.audioTrack;
				const decoderConfig = await sourceTrack.getDecoderConfig();

				const audioTrackBacking = new HlsAudioTrackBacking(
					this.segmentReader,
					sourceTrack.id,
					sourceTrack.codec,
					sourceTrack.numberOfChannels,
					sourceTrack.sampleRate,
					decoderConfig,
					sourceTrack.timeResolution,
				);

				tracks.push(new InputAudioTrack(this.input, audioTrackBacking));
			}

			this.tracks = tracks;
			return tracks;
		}

		// Fallback to ISOBMFF demuxer for non-HLS sources
		return this.isobmffDemuxer.getTracks();
	}

	async getMimeType(): Promise<string> {
		// Return HLS-specific MIME type
		return 'application/vnd.apple.mpegurl';
	}

	async getMetadataTags(): Promise<MetadataTags> {
		await this.initialize();

		// For HLS, metadata is typically minimal
		if (this.segmentReader) {
			// Return empty metadata for now; could be extended to read from playlist
			return {};
		}

		return this.isobmffDemuxer.getMetadataTags();
	}
}
