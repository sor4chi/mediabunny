/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Represents a variant stream in a master playlist.
 * @group Miscellaneous
 * @public
 */
export type VariantStream = {
	/** Average bandwidth in bits per second. */
	bandwidth: number;
	/** Peak bandwidth in bits per second. */
	averageBandwidth?: number;
	/** Video resolution. */
	resolution?: {
		/** Width in pixels. */
		width: number;
		/** Height in pixels. */
		height: number;
	};
	/** Frame rate. */
	frameRate?: number;
	/** Comma-separated list of codec strings. */
	codecs?: string;
	/** URI to the media playlist. */
	uri: string;
	/** Audio group ID. */
	audio?: string;
	/** Video group ID. */
	video?: string;
	/** Subtitles group ID. */
	subtitles?: string;
	/** Closed captions group ID or 'NONE'. */
	closedCaptions?: string;
	/** HDCP level. */
	hdcpLevel?: 'TYPE-0' | 'TYPE-1' | 'NONE';
};

/**
 * Represents an alternative rendition (audio, video, subtitles, closed-captions).
 * @group Miscellaneous
 * @public
 */
export type MediaRendition = {
	/** Type of the rendition. */
	type: 'AUDIO' | 'VIDEO' | 'SUBTITLES' | 'CLOSED-CAPTIONS';
	/** URI to the media playlist (not present for CLOSED-CAPTIONS). */
	uri?: string;
	/** Group ID. */
	groupId: string;
	/** Language tag (RFC 5646). */
	language?: string;
	/** Associated language tag. */
	assocLanguage?: string;
	/** Human-readable name. */
	name: string;
	/** Whether this is the default rendition. */
	default?: boolean;
	/** Whether the user should be able to select this rendition. */
	autoselect?: boolean;
	/** Whether this rendition is forced. */
	forced?: boolean;
	/** Instream ID for closed captions. */
	instreamId?: string;
	/** Characteristics (comma-separated URNs). */
	characteristics?: string;
	/** Channels (e.g., '2' for stereo, '6' for 5.1). */
	channels?: string;
};

/**
 * Represents a master playlist (multivariant playlist).
 * @group Miscellaneous
 * @public
 */
export type MasterPlaylist = {
	/** Playlist type marker. */
	type: 'master';
	/** HLS version. */
	version: number;
	/** Whether the playlist is independent segments. */
	independentSegments?: boolean;
	/** Variant streams. */
	variants: VariantStream[];
	/** Alternative renditions grouped by type and group ID. */
	media: MediaRendition[];
	/** Session data items. */
	sessionData?: SessionDataItem[];
	/** Session key for decryption. */
	sessionKey?: EncryptionKey;
};

/**
 * Represents session data.
 * @group Miscellaneous
 * @public
 */
export type SessionDataItem = {
	/** The data identifier. */
	dataId: string;
	/** The data value (mutually exclusive with uri). */
	value?: string;
	/** URI to the data resource (mutually exclusive with value). */
	uri?: string;
	/** Language tag (RFC 5646). */
	language?: string;
};

/**
 * Represents encryption information.
 * @group Miscellaneous
 * @public
 */
export type EncryptionKey = {
	/** Encryption method. */
	method: 'NONE' | 'AES-128' | 'SAMPLE-AES' | 'SAMPLE-AES-CTR';
	/** URI to the key file. */
	uri?: string;
	/** Initialization vector (16 bytes as hex string). */
	iv?: string;
	/** Key format. */
	keyFormat?: string;
	/** Key format versions. */
	keyFormatVersions?: string;
};

/**
 * Represents a byte range.
 * @group Miscellaneous
 * @public
 */
export type ByteRange = {
	/** Number of bytes. */
	length: number;
	/** Byte offset (optional, defaults to continuing from previous). */
	offset?: number;
};

/**
 * Represents the initialization segment (EXT-X-MAP).
 * @group Miscellaneous
 * @public
 */
export type InitSegment = {
	/** URI to the initialization segment. */
	uri: string;
	/** Byte range within the resource. */
	byteRange?: ByteRange;
};

/**
 * Represents a media segment.
 * @group Miscellaneous
 * @public
 */
export type MediaSegment = {
	/** Segment duration in seconds. */
	duration: number;
	/** Optional human-readable title. */
	title?: string;
	/** URI to the segment. */
	uri: string;
	/** Byte range within the resource. */
	byteRange?: ByteRange;
	/** Whether there is a discontinuity before this segment. */
	discontinuity?: boolean;
	/** Program date/time (ISO 8601). */
	programDateTime?: Date;
	/** Encryption key applying to this segment. */
	key?: EncryptionKey;
	/** Initialization segment applying to this segment. */
	map?: InitSegment;
	/** Gap marker (content unavailable). */
	gap?: boolean;
	/** Bitrate of the segment. */
	bitrate?: number;
};

/**
 * Date range information.
 * @group Miscellaneous
 * @public
 */
export type DateRange = {
	/** Unique identifier for this date range. */
	id: string;
	/** Client-defined class for grouping date ranges. */
	class?: string;
	/** Start date of the range. */
	startDate: Date;
	/** End date of the range. */
	endDate?: Date;
	/** Duration in seconds. */
	duration?: number;
	/** Expected duration in seconds. */
	plannedDuration?: number;
	/** SCTE-35 command data. */
	scte35Cmd?: string;
	/** SCTE-35 out data. */
	scte35Out?: string;
	/** SCTE-35 in data. */
	scte35In?: string;
	/** Whether this date range ends at the next date range with the same class. */
	endOnNext?: boolean;
	/** Custom client-defined attributes. */
	clientAttributes?: Record<string, string | number>;
};

/**
 * Represents a media playlist.
 * @group Miscellaneous
 * @public
 */
export type MediaPlaylist = {
	/** Playlist type marker. */
	type: 'media';
	/** HLS version. */
	version: number;
	/** Target duration in seconds (maximum segment duration). */
	targetDuration: number;
	/** Media sequence number of the first segment. */
	mediaSequence: number;
	/** Discontinuity sequence number. */
	discontinuitySequence?: number;
	/** Playlist type. */
	playlistType?: 'VOD' | 'EVENT';
	/** Whether segments can be loaded independently. */
	independentSegments?: boolean;
	/** Whether the playlist has ended. */
	endList: boolean;
	/** I-frames only playlist marker. */
	iFramesOnly?: boolean;
	/** Media segments. */
	segments: MediaSegment[];
	/** Date ranges. */
	dateRanges?: DateRange[];
	/** Start offset. */
	start?: {
		/** Time offset in seconds from the beginning or end of the playlist. */
		timeOffset: number;
		/** Whether the time offset should be treated as precise. */
		precise?: boolean;
	};
};

/**
 * Union type for any HLS playlist.
 * @group Miscellaneous
 * @public
 */
export type Playlist = MasterPlaylist | MediaPlaylist;
