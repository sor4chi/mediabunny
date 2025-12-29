/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type {
	ByteRange,
	EncryptionKey,
	InitSegment,
	MasterPlaylist,
	MediaPlaylist,
	MediaRendition,
	Playlist,
	VariantStream,
} from './m3u8-types';

/**
 * Writes a playlist (master or media) to an M3U8 string.
 * @group Miscellaneous
 * @public
 */
export const writePlaylist = (playlist: Playlist): string => {
	if (playlist.type === 'master') {
		return writeMasterPlaylist(playlist);
	} else {
		return writeMediaPlaylist(playlist);
	}
};

/**
 * Writes a master playlist to an M3U8 string.
 * @group Miscellaneous
 * @public
 */
export const writeMasterPlaylist = (playlist: MasterPlaylist): string => {
	const lines: string[] = ['#EXTM3U'];

	if (playlist.version > 1) {
		lines.push(`#EXT-X-VERSION:${playlist.version}`);
	}

	if (playlist.independentSegments) {
		lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
	}

	// Write session data
	if (playlist.sessionData) {
		for (const item of playlist.sessionData) {
			const attrs: string[] = [`DATA-ID="${item.dataId}"`];
			if (item.value !== undefined) {
				attrs.push(`VALUE="${escapeQuotes(item.value)}"`);
			}
			if (item.uri !== undefined) {
				attrs.push(`URI="${item.uri}"`);
			}
			if (item.language !== undefined) {
				attrs.push(`LANGUAGE="${item.language}"`);
			}
			lines.push(`#EXT-X-SESSION-DATA:${attrs.join(',')}`);
		}
	}

	// Write session key
	if (playlist.sessionKey) {
		lines.push(`#EXT-X-SESSION-KEY:${writeKey(playlist.sessionKey)}`);
	}

	// Write media renditions
	for (const media of playlist.media) {
		lines.push(`#EXT-X-MEDIA:${writeMediaRendition(media)}`);
	}

	// Write variant streams
	for (const variant of playlist.variants) {
		lines.push(`#EXT-X-STREAM-INF:${writeStreamInf(variant)}`);
		lines.push(variant.uri);
	}

	return lines.join('\n') + '\n';
};

/**
 * Writes a media playlist to an M3U8 string.
 * @group Miscellaneous
 * @public
 */
export const writeMediaPlaylist = (playlist: MediaPlaylist): string => {
	const lines: string[] = ['#EXTM3U'];

	if (playlist.version > 1) {
		lines.push(`#EXT-X-VERSION:${playlist.version}`);
	}

	lines.push(`#EXT-X-TARGETDURATION:${playlist.targetDuration}`);

	if (playlist.mediaSequence !== 0) {
		lines.push(`#EXT-X-MEDIA-SEQUENCE:${playlist.mediaSequence}`);
	}

	if (playlist.discontinuitySequence !== undefined && playlist.discontinuitySequence !== 0) {
		lines.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${playlist.discontinuitySequence}`);
	}

	if (playlist.playlistType) {
		lines.push(`#EXT-X-PLAYLIST-TYPE:${playlist.playlistType}`);
	}

	if (playlist.independentSegments) {
		lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
	}

	if (playlist.iFramesOnly) {
		lines.push('#EXT-X-I-FRAMES-ONLY');
	}

	if (playlist.start) {
		const attrs: string[] = [`TIME-OFFSET=${playlist.start.timeOffset}`];
		if (playlist.start.precise) {
			attrs.push('PRECISE=YES');
		}
		lines.push(`#EXT-X-START:${attrs.join(',')}`);
	}

	// Write date ranges
	if (playlist.dateRanges) {
		for (const dateRange of playlist.dateRanges) {
			const attrs: string[] = [
				`ID="${dateRange.id}"`,
				`START-DATE="${dateRange.startDate.toISOString()}"`,
			];
			if (dateRange.class) {
				attrs.push(`CLASS="${dateRange.class}"`);
			}
			if (dateRange.endDate) {
				attrs.push(`END-DATE="${dateRange.endDate.toISOString()}"`);
			}
			if (dateRange.duration !== undefined) {
				attrs.push(`DURATION=${dateRange.duration}`);
			}
			if (dateRange.plannedDuration !== undefined) {
				attrs.push(`PLANNED-DURATION=${dateRange.plannedDuration}`);
			}
			if (dateRange.scte35Cmd) {
				attrs.push(`SCTE35-CMD=${dateRange.scte35Cmd}`);
			}
			if (dateRange.scte35Out) {
				attrs.push(`SCTE35-OUT=${dateRange.scte35Out}`);
			}
			if (dateRange.scte35In) {
				attrs.push(`SCTE35-IN=${dateRange.scte35In}`);
			}
			if (dateRange.endOnNext) {
				attrs.push('END-ON-NEXT=YES');
			}
			if (dateRange.clientAttributes) {
				for (const [key, value] of Object.entries(dateRange.clientAttributes)) {
					if (typeof value === 'string') {
						attrs.push(`${key}="${escapeQuotes(value)}"`);
					} else {
						attrs.push(`${key}=${value}`);
					}
				}
			}
			lines.push(`#EXT-X-DATERANGE:${attrs.join(',')}`);
		}
	}

	// Track current key and map to avoid redundant tags
	let currentKey: EncryptionKey | undefined;
	let currentMap: InitSegment | undefined;

	// Write segments
	for (const segment of playlist.segments) {
		// Write key if changed
		if (segment.key && !keysEqual(segment.key, currentKey)) {
			lines.push(`#EXT-X-KEY:${writeKey(segment.key)}`);
			currentKey = segment.key;
		} else if (!segment.key && currentKey) {
			lines.push('#EXT-X-KEY:METHOD=NONE');
			currentKey = undefined;
		}

		// Write map if changed
		if (segment.map && !mapsEqual(segment.map, currentMap)) {
			lines.push(`#EXT-X-MAP:${writeMap(segment.map)}`);
			currentMap = segment.map;
		}

		// Write discontinuity
		if (segment.discontinuity) {
			lines.push('#EXT-X-DISCONTINUITY');
		}

		// Write program date time
		if (segment.programDateTime) {
			lines.push(`#EXT-X-PROGRAM-DATE-TIME:${segment.programDateTime.toISOString()}`);
		}

		// Write gap
		if (segment.gap) {
			lines.push('#EXT-X-GAP');
		}

		// Write bitrate
		if (segment.bitrate !== undefined) {
			lines.push(`#EXT-X-BITRATE:${Math.round(segment.bitrate / 1000)}`);
		}

		// Write byte range
		if (segment.byteRange) {
			lines.push(`#EXT-X-BYTERANGE:${writeByteRange(segment.byteRange)}`);
		}

		// Write EXTINF and URI
		const title = segment.title ? `,${segment.title}` : ',';
		lines.push(`#EXTINF:${formatDuration(segment.duration)}${title}`);
		lines.push(segment.uri);
	}

	// Write endlist
	if (playlist.endList) {
		lines.push('#EXT-X-ENDLIST');
	}

	return lines.join('\n') + '\n';
};

// Helper functions

function escapeQuotes(str: string): string {
	return str.replace(/"/g, '\\"');
}

function formatDuration(duration: number): string {
	// Use up to 3 decimal places, but trim trailing zeros
	const fixed = duration.toFixed(3);
	return fixed.replace(/\.?0+$/, '') || '0';
}

function writeStreamInf(variant: VariantStream): string {
	const attrs: string[] = [`BANDWIDTH=${variant.bandwidth}`];

	if (variant.averageBandwidth !== undefined) {
		attrs.push(`AVERAGE-BANDWIDTH=${variant.averageBandwidth}`);
	}

	if (variant.codecs) {
		attrs.push(`CODECS="${variant.codecs}"`);
	}

	if (variant.resolution) {
		attrs.push(`RESOLUTION=${variant.resolution.width}x${variant.resolution.height}`);
	}

	if (variant.frameRate !== undefined) {
		attrs.push(`FRAME-RATE=${variant.frameRate}`);
	}

	if (variant.hdcpLevel) {
		attrs.push(`HDCP-LEVEL=${variant.hdcpLevel}`);
	}

	if (variant.audio) {
		attrs.push(`AUDIO="${variant.audio}"`);
	}

	if (variant.video) {
		attrs.push(`VIDEO="${variant.video}"`);
	}

	if (variant.subtitles) {
		attrs.push(`SUBTITLES="${variant.subtitles}"`);
	}

	if (variant.closedCaptions !== undefined) {
		if (variant.closedCaptions === 'NONE') {
			attrs.push('CLOSED-CAPTIONS=NONE');
		} else {
			attrs.push(`CLOSED-CAPTIONS="${variant.closedCaptions}"`);
		}
	}

	return attrs.join(',');
}

function writeMediaRendition(media: MediaRendition): string {
	const attrs: string[] = [
		`TYPE=${media.type}`,
		`GROUP-ID="${media.groupId}"`,
		`NAME="${escapeQuotes(media.name)}"`,
	];

	if (media.uri) {
		attrs.push(`URI="${media.uri}"`);
	}

	if (media.language) {
		attrs.push(`LANGUAGE="${media.language}"`);
	}

	if (media.assocLanguage) {
		attrs.push(`ASSOC-LANGUAGE="${media.assocLanguage}"`);
	}

	if (media.default) {
		attrs.push('DEFAULT=YES');
	}

	if (media.autoselect) {
		attrs.push('AUTOSELECT=YES');
	}

	if (media.forced) {
		attrs.push('FORCED=YES');
	}

	if (media.instreamId) {
		attrs.push(`INSTREAM-ID="${media.instreamId}"`);
	}

	if (media.characteristics) {
		attrs.push(`CHARACTERISTICS="${media.characteristics}"`);
	}

	if (media.channels) {
		attrs.push(`CHANNELS="${media.channels}"`);
	}

	return attrs.join(',');
}

function writeKey(key: EncryptionKey): string {
	const attrs: string[] = [`METHOD=${key.method}`];

	if (key.uri) {
		attrs.push(`URI="${key.uri}"`);
	}

	if (key.iv) {
		attrs.push(`IV=0x${key.iv}`);
	}

	if (key.keyFormat) {
		attrs.push(`KEYFORMAT="${key.keyFormat}"`);
	}

	if (key.keyFormatVersions) {
		attrs.push(`KEYFORMATVERSIONS="${key.keyFormatVersions}"`);
	}

	return attrs.join(',');
}

function writeMap(map: InitSegment): string {
	const attrs: string[] = [`URI="${map.uri}"`];

	if (map.byteRange) {
		attrs.push(`BYTERANGE="${writeByteRange(map.byteRange)}"`);
	}

	return attrs.join(',');
}

function writeByteRange(byteRange: ByteRange): string {
	if (byteRange.offset !== undefined) {
		return `${byteRange.length}@${byteRange.offset}`;
	}
	return `${byteRange.length}`;
}

function keysEqual(a: EncryptionKey, b: EncryptionKey | undefined): boolean {
	if (!b) return false;
	return a.method === b.method
		&& a.uri === b.uri
		&& a.iv === b.iv
		&& a.keyFormat === b.keyFormat
		&& a.keyFormatVersions === b.keyFormatVersions;
}

function mapsEqual(a: InitSegment, b: InitSegment | undefined): boolean {
	if (!b) return false;
	return a.uri === b.uri
		&& a.byteRange?.length === b.byteRange?.length
		&& a.byteRange?.offset === b.byteRange?.offset;
}
