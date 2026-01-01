/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// M3U8 Types
export type {
	ByteRange,
	DateRange,
	EncryptionKey,
	InitSegment,
	MasterPlaylist,
	MediaPlaylist,
	MediaRendition,
	MediaSegment,
	Playlist,
	SessionDataItem,
	VariantStream,
} from './m3u8-types';

// M3U8 Parser
export {
	M3U8ParseError,
	parseMasterPlaylist,
	parseMediaPlaylist,
	parsePlaylist,
} from './m3u8-parser';

// M3U8 Writer
export {
	writeMasterPlaylist,
	writeMediaPlaylist,
	writePlaylist,
} from './m3u8-writer';

// HLS Types
export type { HlsSegmentInfo } from './hls-types';

// HLS Output Format
export { HlsOutputFormat } from './hls-output-format';
export type { HlsOutputFormatOptions } from './hls-output-format';

// HLS Targets
export {
	HlsTarget,
	HlsBufferTarget,
	HlsCallbackTarget,
	HlsFileSystemTarget,
} from './hls-target';
export type {
	HlsCallbackTargetOptions,
	HlsFileSystemTargetOptions,
} from './hls-target';

// HLS Source (Input)
export { HlsSource } from './hls-source';
export type {
	HlsSourceOptions,
	HlsQualitySelection,
	HlsQualitySelectionByBandwidth,
	HlsQualitySelectionByResolution,
	HlsResolvedStream,
} from './hls-source';

// HLS Input Format
export { HlsInputFormat, HLS_INPUT } from './hls-input-format';

// HLS Virtual Source (bridges HlsSource with Input API)
export { HlsVirtualSource, createHlsVirtualSource } from './hls-virtual-source';
export type { HlsVirtualSourceOptions } from './hls-virtual-source';
