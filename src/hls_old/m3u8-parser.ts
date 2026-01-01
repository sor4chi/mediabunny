/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
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

/**
 * Error thrown when parsing an M3U8 playlist fails.
 * @group Miscellaneous
 * @public
 */
export class M3U8ParseError extends Error {
	/** The line number where the error occurred, if available. */
	public lineNumber?: number;

	/**
	 * Creates a new M3U8ParseError.
	 * @param message - The error message.
	 * @param lineNumber - The line number where the error occurred.
	 */
	constructor(message: string, lineNumber?: number) {
		super(lineNumber !== undefined ? `Line ${lineNumber}: ${message}` : message);
		this.name = 'M3U8ParseError';
		this.lineNumber = lineNumber;
	}
}

/**
 * Parses an M3U8 playlist string.
 * Automatically detects whether it's a master or media playlist.
 * @group Miscellaneous
 * @public
 */
export const parsePlaylist = (content: string): Playlist => {
	const lines = content.split(/\r?\n/);

	if (lines.length === 0 || !lines[0]!.startsWith('#EXTM3U')) {
		throw new M3U8ParseError('Missing #EXTM3U header');
	}

	// Detect playlist type by looking for master playlist tags
	const isMaster = lines.some(line =>
		line.startsWith('#EXT-X-STREAM-INF:')
		|| line.startsWith('#EXT-X-MEDIA:')
		|| line.startsWith('#EXT-X-I-FRAME-STREAM-INF:'),
	);

	if (isMaster) {
		return parseMasterPlaylist(content);
	} else {
		return parseMediaPlaylist(content);
	}
};

/**
 * Parses a master playlist string.
 * @group Miscellaneous
 * @public
 */
export const parseMasterPlaylist = (content: string): MasterPlaylist => {
	const lines = content.split(/\r?\n/);

	if (lines.length === 0 || !lines[0]!.startsWith('#EXTM3U')) {
		throw new M3U8ParseError('Missing #EXTM3U header');
	}

	const playlist: MasterPlaylist = {
		type: 'master',
		version: 1,
		variants: [],
		media: [],
	};

	let pendingVariant: Partial<VariantStream> | null = null;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trim();
		const lineNumber = i + 1;

		if (line === '' || line === '#EXTM3U') {
			continue;
		}

		if (line.startsWith('#EXT-X-VERSION:')) {
			playlist.version = parseInt(line.slice(15), 10);
		} else if (line.startsWith('#EXT-X-INDEPENDENT-SEGMENTS')) {
			playlist.independentSegments = true;
		} else if (line.startsWith('#EXT-X-STREAM-INF:')) {
			pendingVariant = parseStreamInf(line.slice(18), lineNumber);
		} else if (line.startsWith('#EXT-X-MEDIA:')) {
			const media = parseMedia(line.slice(13), lineNumber);
			playlist.media.push(media);
		} else if (line.startsWith('#EXT-X-SESSION-DATA:')) {
			const sessionData = parseSessionData(line.slice(20), lineNumber);
			playlist.sessionData ??= [];
			playlist.sessionData.push(sessionData);
		} else if (line.startsWith('#EXT-X-SESSION-KEY:')) {
			playlist.sessionKey = parseKey(line.slice(19), lineNumber);
		} else if (!line.startsWith('#') && line !== '') {
			// URI line
			if (pendingVariant) {
				pendingVariant.uri = line;
				playlist.variants.push(pendingVariant as VariantStream);
				pendingVariant = null;
			}
		}
	}

	return playlist;
};

/**
 * Parses a media playlist string.
 * @group Miscellaneous
 * @public
 */
export const parseMediaPlaylist = (content: string): MediaPlaylist => {
	const lines = content.split(/\r?\n/);

	if (lines.length === 0 || !lines[0]!.startsWith('#EXTM3U')) {
		throw new M3U8ParseError('Missing #EXTM3U header');
	}

	const playlist: MediaPlaylist = {
		type: 'media',
		version: 1,
		targetDuration: 0,
		mediaSequence: 0,
		endList: false,
		segments: [],
	};

	let pendingSegment: Partial<MediaSegment> = {};
	let currentKey: EncryptionKey | undefined;
	let currentMap: InitSegment | undefined;
	let lastByteRangeEnd = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!.trim();
		const lineNumber = i + 1;

		if (line === '' || line === '#EXTM3U') {
			continue;
		}

		if (line.startsWith('#EXT-X-VERSION:')) {
			playlist.version = parseInt(line.slice(15), 10);
		} else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
			playlist.targetDuration = parseInt(line.slice(22), 10);
		} else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
			playlist.mediaSequence = parseInt(line.slice(22), 10);
		} else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
			playlist.discontinuitySequence = parseInt(line.slice(30), 10);
		} else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
			const type = line.slice(21);
			if (type === 'VOD' || type === 'EVENT') {
				playlist.playlistType = type;
			}
		} else if (line.startsWith('#EXT-X-INDEPENDENT-SEGMENTS')) {
			playlist.independentSegments = true;
		} else if (line === '#EXT-X-ENDLIST') {
			playlist.endList = true;
		} else if (line === '#EXT-X-I-FRAMES-ONLY') {
			playlist.iFramesOnly = true;
		} else if (line.startsWith('#EXTINF:')) {
			const match = /^#EXTINF:([\d.]+)(?:,(.*))?$/.exec(line);
			if (match) {
				pendingSegment.duration = parseFloat(match[1]!);
				if (match[2]) {
					pendingSegment.title = match[2];
				}
			}
		} else if (line.startsWith('#EXT-X-BYTERANGE:')) {
			pendingSegment.byteRange = parseByteRange(line.slice(17), lastByteRangeEnd);
		} else if (line === '#EXT-X-DISCONTINUITY') {
			pendingSegment.discontinuity = true;
		} else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
			pendingSegment.programDateTime = new Date(line.slice(25));
		} else if (line.startsWith('#EXT-X-KEY:')) {
			currentKey = parseKey(line.slice(11), lineNumber);
		} else if (line.startsWith('#EXT-X-MAP:')) {
			currentMap = parseMap(line.slice(11), lineNumber);
		} else if (line === '#EXT-X-GAP') {
			pendingSegment.gap = true;
		} else if (line.startsWith('#EXT-X-BITRATE:')) {
			pendingSegment.bitrate = parseInt(line.slice(15), 10) * 1000;
		} else if (line.startsWith('#EXT-X-DATERANGE:')) {
			const dateRange = parseDateRange(line.slice(17), lineNumber);
			playlist.dateRanges ??= [];
			playlist.dateRanges.push(dateRange);
		} else if (line.startsWith('#EXT-X-START:')) {
			playlist.start = parseStart(line.slice(13));
		} else if (!line.startsWith('#') && line !== '') {
			// URI line - create segment
			const segment: MediaSegment = {
				duration: pendingSegment.duration ?? 0,
				uri: line,
				...pendingSegment,
			};

			if (currentKey && currentKey.method !== 'NONE') {
				segment.key = currentKey;
			}
			if (currentMap) {
				segment.map = currentMap;
			}

			// Track byte range end for relative byte ranges
			if (segment.byteRange?.offset !== undefined) {
				lastByteRangeEnd = segment.byteRange.offset + segment.byteRange.length;
			}

			playlist.segments.push(segment);
			pendingSegment = {};
		}
	}

	return playlist;
};

// Attribute parsing helpers

function parseAttributeList(str: string): Map<string, string> {
	const attrs = new Map<string, string>();
	const regex = /([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/g;
	let match;

	while ((match = regex.exec(str)) !== null) {
		const key = match[1]!;
		const value = match[2] ?? match[3]!;
		attrs.set(key, value);
	}

	return attrs;
}

function parseStreamInf(str: string, lineNumber: number): Partial<VariantStream> {
	const attrs = parseAttributeList(str);
	const variant: Partial<VariantStream> = {};

	const bandwidth = attrs.get('BANDWIDTH');
	if (!bandwidth) {
		throw new M3U8ParseError('EXT-X-STREAM-INF missing BANDWIDTH', lineNumber);
	}
	variant.bandwidth = parseInt(bandwidth, 10);

	const avgBandwidth = attrs.get('AVERAGE-BANDWIDTH');
	if (avgBandwidth) {
		variant.averageBandwidth = parseInt(avgBandwidth, 10);
	}

	const resolution = attrs.get('RESOLUTION');
	if (resolution) {
		const [width, height] = resolution.split('x').map(Number);
		if (width !== undefined && height !== undefined) {
			variant.resolution = { width, height };
		}
	}

	const frameRate = attrs.get('FRAME-RATE');
	if (frameRate) {
		variant.frameRate = parseFloat(frameRate);
	}

	const codecs = attrs.get('CODECS');
	if (codecs) {
		variant.codecs = codecs;
	}

	const audio = attrs.get('AUDIO');
	if (audio) {
		variant.audio = audio;
	}

	const video = attrs.get('VIDEO');
	if (video) {
		variant.video = video;
	}

	const subtitles = attrs.get('SUBTITLES');
	if (subtitles) {
		variant.subtitles = subtitles;
	}

	const closedCaptions = attrs.get('CLOSED-CAPTIONS');
	if (closedCaptions) {
		variant.closedCaptions = closedCaptions === 'NONE' ? 'NONE' : closedCaptions;
	}

	const hdcpLevel = attrs.get('HDCP-LEVEL');
	if (hdcpLevel === 'TYPE-0' || hdcpLevel === 'TYPE-1' || hdcpLevel === 'NONE') {
		variant.hdcpLevel = hdcpLevel;
	}

	return variant;
}

function parseMedia(str: string, lineNumber: number): MediaRendition {
	const attrs = parseAttributeList(str);

	const type = attrs.get('TYPE') as MediaRendition['type'];
	if (!type || !['AUDIO', 'VIDEO', 'SUBTITLES', 'CLOSED-CAPTIONS'].includes(type)) {
		throw new M3U8ParseError('EXT-X-MEDIA missing or invalid TYPE', lineNumber);
	}

	const groupId = attrs.get('GROUP-ID');
	if (!groupId) {
		throw new M3U8ParseError('EXT-X-MEDIA missing GROUP-ID', lineNumber);
	}

	const name = attrs.get('NAME');
	if (!name) {
		throw new M3U8ParseError('EXT-X-MEDIA missing NAME', lineNumber);
	}

	const media: MediaRendition = {
		type,
		groupId,
		name,
	};

	const uri = attrs.get('URI');
	if (uri) {
		media.uri = uri;
	}

	const language = attrs.get('LANGUAGE');
	if (language) {
		media.language = language;
	}

	const assocLanguage = attrs.get('ASSOC-LANGUAGE');
	if (assocLanguage) {
		media.assocLanguage = assocLanguage;
	}

	if (attrs.get('DEFAULT') === 'YES') {
		media.default = true;
	}

	if (attrs.get('AUTOSELECT') === 'YES') {
		media.autoselect = true;
	}

	if (attrs.get('FORCED') === 'YES') {
		media.forced = true;
	}

	const instreamId = attrs.get('INSTREAM-ID');
	if (instreamId) {
		media.instreamId = instreamId;
	}

	const characteristics = attrs.get('CHARACTERISTICS');
	if (characteristics) {
		media.characteristics = characteristics;
	}

	const channels = attrs.get('CHANNELS');
	if (channels) {
		media.channels = channels;
	}

	return media;
}

function parseSessionData(str: string, lineNumber: number): SessionDataItem {
	const attrs = parseAttributeList(str);

	const dataId = attrs.get('DATA-ID');
	if (!dataId) {
		throw new M3U8ParseError('EXT-X-SESSION-DATA missing DATA-ID', lineNumber);
	}

	const item: SessionDataItem = { dataId };

	const value = attrs.get('VALUE');
	if (value) {
		item.value = value;
	}

	const uri = attrs.get('URI');
	if (uri) {
		item.uri = uri;
	}

	const language = attrs.get('LANGUAGE');
	if (language) {
		item.language = language;
	}

	return item;
}

function parseKey(str: string, lineNumber: number): EncryptionKey {
	const attrs = parseAttributeList(str);

	const method = attrs.get('METHOD') as EncryptionKey['method'];
	if (!method || !['NONE', 'AES-128', 'SAMPLE-AES', 'SAMPLE-AES-CTR'].includes(method)) {
		throw new M3U8ParseError('EXT-X-KEY missing or invalid METHOD', lineNumber);
	}

	const key: EncryptionKey = { method };

	const uri = attrs.get('URI');
	if (uri) {
		key.uri = uri;
	}

	const iv = attrs.get('IV');
	if (iv) {
		key.iv = iv.startsWith('0x') || iv.startsWith('0X') ? iv.slice(2) : iv;
	}

	const keyFormat = attrs.get('KEYFORMAT');
	if (keyFormat) {
		key.keyFormat = keyFormat;
	}

	const keyFormatVersions = attrs.get('KEYFORMATVERSIONS');
	if (keyFormatVersions) {
		key.keyFormatVersions = keyFormatVersions;
	}

	return key;
}

function parseMap(str: string, lineNumber: number): InitSegment {
	const attrs = parseAttributeList(str);

	const uri = attrs.get('URI');
	if (!uri) {
		throw new M3U8ParseError('EXT-X-MAP missing URI', lineNumber);
	}

	const map: InitSegment = { uri };

	const byteRange = attrs.get('BYTERANGE');
	if (byteRange) {
		map.byteRange = parseByteRange(byteRange, 0);
	}

	return map;
}

function parseByteRange(str: string, lastEnd: number): ByteRange {
	const parts = str.split('@');
	const length = parseInt(parts[0]!, 10);
	const offset = parts[1] !== undefined ? parseInt(parts[1], 10) : lastEnd;

	return { length, offset };
}

function parseDateRange(str: string, lineNumber: number): DateRange {
	const attrs = parseAttributeList(str);

	const id = attrs.get('ID');
	if (!id) {
		throw new M3U8ParseError('EXT-X-DATERANGE missing ID', lineNumber);
	}

	const startDateStr = attrs.get('START-DATE');
	if (!startDateStr) {
		throw new M3U8ParseError('EXT-X-DATERANGE missing START-DATE', lineNumber);
	}

	const dateRange: DateRange = {
		id,
		startDate: new Date(startDateStr),
	};

	const classAttr = attrs.get('CLASS');
	if (classAttr) {
		dateRange.class = classAttr;
	}

	const endDate = attrs.get('END-DATE');
	if (endDate) {
		dateRange.endDate = new Date(endDate);
	}

	const duration = attrs.get('DURATION');
	if (duration) {
		dateRange.duration = parseFloat(duration);
	}

	const plannedDuration = attrs.get('PLANNED-DURATION');
	if (plannedDuration) {
		dateRange.plannedDuration = parseFloat(plannedDuration);
	}

	const scte35Cmd = attrs.get('SCTE35-CMD');
	if (scte35Cmd) {
		dateRange.scte35Cmd = scte35Cmd;
	}

	const scte35Out = attrs.get('SCTE35-OUT');
	if (scte35Out) {
		dateRange.scte35Out = scte35Out;
	}

	const scte35In = attrs.get('SCTE35-IN');
	if (scte35In) {
		dateRange.scte35In = scte35In;
	}

	if (attrs.get('END-ON-NEXT') === 'YES') {
		dateRange.endOnNext = true;
	}

	// Parse client-defined attributes (X-*)
	const clientAttributes: Record<string, string | number> = {};
	for (const [key, value] of attrs) {
		if (key.startsWith('X-')) {
			// Try to parse as number, otherwise keep as string
			const numValue = parseFloat(value);
			clientAttributes[key] = isNaN(numValue) ? value : numValue;
		}
	}
	if (Object.keys(clientAttributes).length > 0) {
		dateRange.clientAttributes = clientAttributes;
	}

	return dateRange;
}

function parseStart(str: string): { timeOffset: number; precise?: boolean } {
	const attrs = parseAttributeList(str);

	const timeOffset = attrs.get('TIME-OFFSET');
	const result: { timeOffset: number; precise?: boolean } = {
		timeOffset: timeOffset ? parseFloat(timeOffset) : 0,
	};

	if (attrs.get('PRECISE') === 'YES') {
		result.precise = true;
	}

	return result;
}
