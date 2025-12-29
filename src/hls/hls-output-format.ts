/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { MediaCodec, NON_PCM_AUDIO_CODECS, SUBTITLE_CODECS, VIDEO_CODECS } from '../codec';
import { Output } from '../output';
import { OutputFormat, TrackCountLimits } from '../output-format';
import { HlsMuxer } from './hls-muxer';

/**
 * Options for HLS output format.
 * @group Output formats
 * @public
 */
export type HlsOutputFormatOptions = {
	/**
	 * Target duration for each segment in seconds. Segments will be created at keyframe boundaries
	 * that are closest to this duration. Defaults to 6 seconds.
	 */
	segmentDuration?: number;

	/**
	 * The playlist type. Use 'VOD' for video on demand (complete file), 'EVENT' for live events
	 * that will eventually end, or undefined for live streams that use a sliding window.
	 */
	playlistType?: 'VOD' | 'EVENT';

	/**
	 * File name pattern for segment files. Use `\{number\}` as placeholder for segment number.
	 * Defaults to 'segment\{number\}.m4s'.
	 */
	segmentFilePattern?: string;

	/**
	 * File name for the initialization segment. Defaults to 'init.mp4'.
	 */
	initSegmentFileName?: string;

	/**
	 * File name for the media playlist. Defaults to 'playlist.m3u8'.
	 */
	playlistFileName?: string;

	/**
	 * For live streams, the maximum number of segments to keep in the playlist.
	 * Older segments will be removed. Defaults to 5.
	 */
	maxSegmentCount?: number;
};

/**
 * HLS (HTTP Live Streaming) output format using fMP4 segments.
 * @group Output formats
 * @public
 */
export class HlsOutputFormat extends OutputFormat {
	/** @internal */
	_options: Required<HlsOutputFormatOptions>;

	/** Creates a new {@link HlsOutputFormat} configured with the specified `options`. */
	constructor(options: HlsOutputFormatOptions = {}) {
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}
		if (
			options.segmentDuration !== undefined
			&& (!Number.isFinite(options.segmentDuration) || options.segmentDuration <= 0)
		) {
			throw new TypeError('options.segmentDuration, when provided, must be a positive number.');
		}
		if (
			options.playlistType !== undefined
			&& options.playlistType !== 'VOD'
			&& options.playlistType !== 'EVENT'
		) {
			throw new TypeError('options.playlistType, when provided, must be \'VOD\' or \'EVENT\'.');
		}
		if (options.segmentFilePattern !== undefined && typeof options.segmentFilePattern !== 'string') {
			throw new TypeError('options.segmentFilePattern, when provided, must be a string.');
		}
		if (options.initSegmentFileName !== undefined && typeof options.initSegmentFileName !== 'string') {
			throw new TypeError('options.initSegmentFileName, when provided, must be a string.');
		}
		if (options.playlistFileName !== undefined && typeof options.playlistFileName !== 'string') {
			throw new TypeError('options.playlistFileName, when provided, must be a string.');
		}
		if (
			options.maxSegmentCount !== undefined
			&& (!Number.isInteger(options.maxSegmentCount) || options.maxSegmentCount < 1)
		) {
			throw new TypeError('options.maxSegmentCount, when provided, must be a positive integer.');
		}

		super();

		this._options = {
			segmentDuration: options.segmentDuration ?? 6,
			playlistType: options.playlistType as 'VOD' | 'EVENT',
			segmentFilePattern: options.segmentFilePattern ?? 'segment{number}.m4s',
			initSegmentFileName: options.initSegmentFileName ?? 'init.mp4',
			playlistFileName: options.playlistFileName ?? 'playlist.m3u8',
			maxSegmentCount: options.maxSegmentCount ?? 5,
		};
	}

	/** @internal */
	_createMuxer(output: Output) {
		return new HlsMuxer(output, this);
	}

	/** @internal */
	get _name() {
		return 'HLS';
	}

	get fileExtension() {
		return '.m3u8';
	}

	get mimeType() {
		return 'application/vnd.apple.mpegurl';
	}

	getSupportedCodecs(): MediaCodec[] {
		// HLS with fMP4 supports the same codecs as MP4
		return [
			...VIDEO_CODECS,
			...NON_PCM_AUDIO_CODECS,
			...SUBTITLE_CODECS,
		];
	}

	getSupportedTrackCounts(): TrackCountLimits {
		return {
			video: { min: 0, max: 1 }, // HLS typically has one video track per variant
			audio: { min: 0, max: Infinity },
			subtitle: { min: 0, max: Infinity },
			total: { min: 1, max: Infinity },
		};
	}

	get supportsVideoRotationMetadata() {
		return true; // fMP4 supports rotation metadata
	}
}
