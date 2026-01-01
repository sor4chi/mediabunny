import { expect, test, describe } from 'vitest';
import {
	parsePlaylist,
	parseMasterPlaylist,
	parseMediaPlaylist,
	writePlaylist,
	writeMasterPlaylist,
	writeMediaPlaylist,
	M3U8ParseError,
} from '../../src/hls_old/index.js';
import type {
	MasterPlaylist,
	MediaPlaylist,
	EncryptionKey,
} from '../../src/hls_old/index.js';

// ============================================================================
// Basic Parsing Tests
// ============================================================================

describe('parsePlaylist', () => {
	test('detects master playlist', () => {
		const m3u8 = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-STREAM-INF:BANDWIDTH=1280000,CODECS="avc1.640028,mp4a.40.2"
video.m3u8
`;
		const playlist = parsePlaylist(m3u8);
		expect(playlist.type).toBe('master');
	});

	test('detects media playlist', () => {
		const m3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXTINF:9.009,
segment0.ts
#EXT-X-ENDLIST
`;
		const playlist = parsePlaylist(m3u8);
		expect(playlist.type).toBe('media');
	});

	test('throws error for missing #EXTM3U tag', () => {
		const m3u8 = `#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
`;
		expect(() => parsePlaylist(m3u8)).toThrow(M3U8ParseError);
	});

	test('parses ambiguous playlist as media playlist with defaults', () => {
		const m3u8 = `#EXTM3U
#EXT-X-VERSION:3
`;
		// This playlist has neither STREAM-INF (master) nor EXTINF (media)
		// The parser treats it as an empty media playlist with defaults
		const playlist = parsePlaylist(m3u8);
		expect(playlist.type).toBe('media');
		expect((playlist as MediaPlaylist).targetDuration).toBe(0);
		expect((playlist as MediaPlaylist).segments).toHaveLength(0);
	});
});

// ============================================================================
// Master Playlist Parsing Tests
// ============================================================================

describe('parseMasterPlaylist', () => {
	test('parses basic master playlist', () => {
		const m3u8 = `#EXTM3U
#EXT-X-VERSION:4
#EXT-X-STREAM-INF:BANDWIDTH=1280000
low/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000
mid/video.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=7680000
high/video.m3u8
`;
		const playlist = parseMasterPlaylist(m3u8);
		expect(playlist.type).toBe('master');
		expect(playlist.version).toBe(4);
		expect(playlist.variants).toHaveLength(3);
		expect(playlist.variants[0]!.bandwidth).toBe(1280000);
		expect(playlist.variants[0]!.uri).toBe('low/video.m3u8');
		expect(playlist.variants[1]!.bandwidth).toBe(2560000);
		expect(playlist.variants[2]!.bandwidth).toBe(7680000);
	});

	test('parses variant stream with all attributes', () => {
		const streamInf = '#EXT-X-STREAM-INF:BANDWIDTH=1280000,AVERAGE-BANDWIDTH=1000000,'
			+ 'CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,FRAME-RATE=30,'
			+ 'HDCP-LEVEL=TYPE-1,AUDIO="audio-group",VIDEO="video-group",'
			+ 'SUBTITLES="subs",CLOSED-CAPTIONS="cc"';
		const m3u8 = `#EXTM3U
${streamInf}
video.m3u8
`;
		const playlist = parseMasterPlaylist(m3u8);
		const variant = playlist.variants[0]!;

		expect(variant.bandwidth).toBe(1280000);
		expect(variant.averageBandwidth).toBe(1000000);
		expect(variant.codecs).toBe('avc1.640028,mp4a.40.2');
		expect(variant.resolution).toEqual({ width: 1920, height: 1080 });
		expect(variant.frameRate).toBe(30);
		expect(variant.hdcpLevel).toBe('TYPE-1');
		expect(variant.audio).toBe('audio-group');
		expect(variant.video).toBe('video-group');
		expect(variant.subtitles).toBe('subs');
		expect(variant.closedCaptions).toBe('cc');
	});

	test('parses CLOSED-CAPTIONS=NONE', () => {
		const m3u8 = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,CLOSED-CAPTIONS=NONE
video.m3u8
`;
		const playlist = parseMasterPlaylist(m3u8);
		expect(playlist.variants[0]!.closedCaptions).toBe('NONE');
	});

	test('parses media renditions', () => {
		const m3u8 = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",LANGUAGE="en",DEFAULT=YES,AUTOSELECT=YES,URI="audio_en.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Japanese",LANGUAGE="ja",DEFAULT=NO,AUTOSELECT=YES,URI="audio_ja.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",FORCED=NO,URI="subs_en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1280000,AUDIO="audio",SUBTITLES="subs"
video.m3u8
`;
		const playlist = parseMasterPlaylist(m3u8);
		expect(playlist.media).toHaveLength(3);

		const audioEn = playlist.media[0]!;
		expect(audioEn.type).toBe('AUDIO');
		expect(audioEn.groupId).toBe('audio');
		expect(audioEn.name).toBe('English');
		expect(audioEn.language).toBe('en');
		expect(audioEn.default).toBe(true);
		expect(audioEn.autoselect).toBe(true);
		expect(audioEn.uri).toBe('audio_en.m3u8');

		const subs = playlist.media[2]!;
		expect(subs.type).toBe('SUBTITLES');
		// FORCED=NO means the attribute wasn't set to YES, so it's undefined
		expect(subs.forced).toBeUndefined();
	});

	test('parses closed-captions rendition with INSTREAM-ID', () => {
		const m3u8 = `#EXTM3U
#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="English",LANGUAGE="en",INSTREAM-ID="CC1",DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=1280000,CLOSED-CAPTIONS="cc"
video.m3u8
`;
		const playlist = parseMasterPlaylist(m3u8);
		const cc = playlist.media[0]!;
		expect(cc.type).toBe('CLOSED-CAPTIONS');
		expect(cc.instreamId).toBe('CC1');
	});

	test('parses audio rendition with CHANNELS', () => {
		const m3u8 = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="Surround",CHANNELS="6",URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1280000,AUDIO="audio"
video.m3u8
`;
		const playlist = parseMasterPlaylist(m3u8);
		expect(playlist.media[0]!.channels).toBe('6');
	});

	test('parses EXT-X-INDEPENDENT-SEGMENTS', () => {
		const m3u8 = `#EXTM3U
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=1280000
video.m3u8
`;
		const playlist = parseMasterPlaylist(m3u8);
		expect(playlist.independentSegments).toBe(true);
	});

	test('parses session data', () => {
		const m3u8 = `#EXTM3U
#EXT-X-SESSION-DATA:DATA-ID="com.example.lyrics",VALUE="Lyrics text here"
#EXT-X-SESSION-DATA:DATA-ID="com.example.config",URI="config.json",LANGUAGE="en"
#EXT-X-STREAM-INF:BANDWIDTH=1280000
video.m3u8
`;
		const playlist = parseMasterPlaylist(m3u8);
		expect(playlist.sessionData).toHaveLength(2);
		expect(playlist.sessionData![0]!.dataId).toBe('com.example.lyrics');
		expect(playlist.sessionData![0]!.value).toBe('Lyrics text here');
		expect(playlist.sessionData![1]!.uri).toBe('config.json');
		expect(playlist.sessionData![1]!.language).toBe('en');
	});

	test('parses session key', () => {
		const m3u8 = `#EXTM3U
#EXT-X-SESSION-KEY:METHOD=AES-128,URI="https://example.com/key.bin",IV=0x1234567890ABCDEF1234567890ABCDEF
#EXT-X-STREAM-INF:BANDWIDTH=1280000
video.m3u8
`;
		const playlist = parseMasterPlaylist(m3u8);
		expect(playlist.sessionKey).toBeDefined();
		expect(playlist.sessionKey!.method).toBe('AES-128');
		expect(playlist.sessionKey!.uri).toBe('https://example.com/key.bin');
		expect(playlist.sessionKey!.iv).toBe('1234567890ABCDEF1234567890ABCDEF');
	});
});

// ============================================================================
// Media Playlist Parsing Tests
// ============================================================================

describe('parseMediaPlaylist', () => {
	test('parses basic media playlist', () => {
		const m3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:9.009,
segment0.ts
#EXTINF:9.009,
segment1.ts
#EXTINF:3.003,
segment2.ts
#EXT-X-ENDLIST
`;
		const playlist = parseMediaPlaylist(m3u8);
		expect(playlist.type).toBe('media');
		expect(playlist.version).toBe(3);
		expect(playlist.targetDuration).toBe(10);
		expect(playlist.mediaSequence).toBe(0);
		expect(playlist.endList).toBe(true);
		expect(playlist.segments).toHaveLength(3);
		expect(playlist.segments[0]!.duration).toBe(9.009);
		expect(playlist.segments[0]!.uri).toBe('segment0.ts');
	});

	test('parses EXTINF with title', () => {
		const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.009,Segment Title
segment0.ts
#EXT-X-ENDLIST
`;
		const playlist = parseMediaPlaylist(m3u8);
		expect(playlist.segments[0]!.title).toBe('Segment Title');
	});

	test('parses byte range', () => {
		const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-BYTERANGE:1000@0
#EXTINF:5,
segment.ts
#EXT-X-BYTERANGE:1000
#EXTINF:5,
segment.ts
#EXT-X-ENDLIST
`;
		const playlist = parseMediaPlaylist(m3u8);
		expect(playlist.segments[0]!.byteRange).toEqual({ length: 1000, offset: 0 });
		// When no offset is specified, it continues from the end of the previous byte range
		// Previous: 1000@0, so end is at 1000. Next: 1000 starting at offset 1000
		expect(playlist.segments[1]!.byteRange).toEqual({ length: 1000, offset: 1000 });
	});

	test('parses discontinuity', () => {
		const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:5,
segment0.ts
#EXT-X-DISCONTINUITY
#EXTINF:5,
segment1.ts
#EXT-X-ENDLIST
`;
		const playlist = parseMediaPlaylist(m3u8);
		expect(playlist.segments[0]!.discontinuity).toBeFalsy();
		expect(playlist.segments[1]!.discontinuity).toBe(true);
	});

	test('parses encryption key', () => {
		const keyTag = '#EXT-X-KEY:METHOD=AES-128,URI="https://example.com/key.bin",'
			+ 'IV=0x1234567890ABCDEF1234567890ABCDEF,KEYFORMAT="identity",KEYFORMATVERSIONS="1"';
		const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:10
${keyTag}
#EXTINF:5,
segment0.ts
#EXTINF:5,
segment1.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:5,
segment2.ts
#EXT-X-ENDLIST
`;
		const playlist = parseMediaPlaylist(m3u8);
		expect(playlist.segments[0]!.key).toBeDefined();
		expect(playlist.segments[0]!.key!.method).toBe('AES-128');
		expect(playlist.segments[0]!.key!.uri).toBe('https://example.com/key.bin');
		expect(playlist.segments[0]!.key!.iv).toBe('1234567890ABCDEF1234567890ABCDEF');
		expect(playlist.segments[0]!.key!.keyFormat).toBe('identity');
		expect(playlist.segments[0]!.key!.keyFormatVersions).toBe('1');

		// Key applies to subsequent segments
		expect(playlist.segments[1]!.key).toEqual(playlist.segments[0]!.key);

		// Key removed
		expect(playlist.segments[2]!.key).toBeUndefined();
	});

	test('parses init segment (EXT-X-MAP)', () => {
		const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MAP:URI="init.mp4"
#EXTINF:5,
segment0.m4s
#EXTINF:5,
segment1.m4s
#EXT-X-MAP:URI="init2.mp4",BYTERANGE="1000@0"
#EXTINF:5,
segment2.m4s
#EXT-X-ENDLIST
`;
		const playlist = parseMediaPlaylist(m3u8);
		expect(playlist.segments[0]!.map).toBeDefined();
		expect(playlist.segments[0]!.map!.uri).toBe('init.mp4');
		expect(playlist.segments[1]!.map).toEqual(playlist.segments[0]!.map);

		expect(playlist.segments[2]!.map!.uri).toBe('init2.mp4');
		expect(playlist.segments[2]!.map!.byteRange).toEqual({ length: 1000, offset: 0 });
	});

	test('parses program date time', () => {
		const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-PROGRAM-DATE-TIME:2021-01-15T12:30:00.000Z
#EXTINF:5,
segment0.ts
#EXT-X-ENDLIST
`;
		const playlist = parseMediaPlaylist(m3u8);
		expect(playlist.segments[0]!.programDateTime).toEqual(new Date('2021-01-15T12:30:00.000Z'));
	});

	test('parses gap', () => {
		const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:5,
segment0.ts
#EXT-X-GAP
#EXTINF:5,
segment1.ts
#EXT-X-ENDLIST
`;
		const playlist = parseMediaPlaylist(m3u8);
		expect(playlist.segments[0]!.gap).toBeFalsy();
		expect(playlist.segments[1]!.gap).toBe(true);
	});

	test('parses bitrate', () => {
		const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-BITRATE:1500
#EXTINF:5,
segment0.ts
#EXT-X-ENDLIST
`;
		const playlist = parseMediaPlaylist(m3u8);
		expect(playlist.segments[0]!.bitrate).toBe(1500000); // Converted to bps
	});

	test('parses playlist type', () => {
		const m3u8Vod = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:5,
segment.ts
#EXT-X-ENDLIST
`;
		const m3u8Event = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-PLAYLIST-TYPE:EVENT
#EXTINF:5,
segment.ts
`;
		const vodPlaylist = parseMediaPlaylist(m3u8Vod);
		const eventPlaylist = parseMediaPlaylist(m3u8Event);

		expect(vodPlaylist.playlistType).toBe('VOD');
		expect(eventPlaylist.playlistType).toBe('EVENT');
	});

	test('parses I-frames only', () => {
		const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-I-FRAMES-ONLY
#EXTINF:5,
iframe.ts
#EXT-X-ENDLIST
`;
		const playlist = parseMediaPlaylist(m3u8);
		expect(playlist.iFramesOnly).toBe(true);
	});

	test('parses discontinuity sequence', () => {
		const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-DISCONTINUITY-SEQUENCE:5
#EXTINF:5,
segment.ts
#EXT-X-ENDLIST
`;
		const playlist = parseMediaPlaylist(m3u8);
		expect(playlist.discontinuitySequence).toBe(5);
	});

	test('parses start tag', () => {
		const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-START:TIME-OFFSET=10.5,PRECISE=YES
#EXTINF:5,
segment.ts
#EXT-X-ENDLIST
`;
		const playlist = parseMediaPlaylist(m3u8);
		expect(playlist.start).toBeDefined();
		expect(playlist.start!.timeOffset).toBe(10.5);
		expect(playlist.start!.precise).toBe(true);
	});

	test('parses date ranges', () => {
		const dateRangeTag = '#EXT-X-DATERANGE:ID="ad-break",CLASS="ad",'
			+ 'START-DATE="2021-01-15T12:30:00Z",END-DATE="2021-01-15T12:30:30Z",'
			+ 'DURATION=30,PLANNED-DURATION=30,END-ON-NEXT=YES,X-CUSTOM-ATTR="value"';
		const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:10
${dateRangeTag}
#EXTINF:5,
segment.ts
#EXT-X-ENDLIST
`;
		const playlist = parseMediaPlaylist(m3u8);
		expect(playlist.dateRanges).toHaveLength(1);

		const dateRange = playlist.dateRanges![0]!;
		expect(dateRange.id).toBe('ad-break');
		expect(dateRange.class).toBe('ad');
		expect(dateRange.startDate).toEqual(new Date('2021-01-15T12:30:00Z'));
		expect(dateRange.endDate).toEqual(new Date('2021-01-15T12:30:30Z'));
		expect(dateRange.duration).toBe(30);
		expect(dateRange.plannedDuration).toBe(30);
		expect(dateRange.endOnNext).toBe(true);
		expect(dateRange.clientAttributes).toEqual({ 'X-CUSTOM-ATTR': 'value' });
	});

	test('parses date range with SCTE-35', () => {
		const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-DATERANGE:ID="splice",START-DATE="2021-01-15T12:30:00Z",SCTE35-CMD=0xFC30,SCTE35-OUT=0xFC31,SCTE35-IN=0xFC32
#EXTINF:5,
segment.ts
#EXT-X-ENDLIST
`;
		const playlist = parseMediaPlaylist(m3u8);
		const dateRange = playlist.dateRanges![0]!;
		expect(dateRange.scte35Cmd).toBe('0xFC30');
		expect(dateRange.scte35Out).toBe('0xFC31');
		expect(dateRange.scte35In).toBe('0xFC32');
	});

	test('handles live playlist without EXT-X-ENDLIST', () => {
		const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:100
#EXTINF:9.009,
segment100.ts
#EXTINF:9.009,
segment101.ts
`;
		const playlist = parseMediaPlaylist(m3u8);
		expect(playlist.endList).toBe(false);
		expect(playlist.mediaSequence).toBe(100);
	});

	test('defaults version to 1 when not specified', () => {
		const m3u8 = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:5,
segment.ts
#EXT-X-ENDLIST
`;
		const playlist = parseMediaPlaylist(m3u8);
		expect(playlist.version).toBe(1);
	});
});

// ============================================================================
// Master Playlist Writer Tests
// ============================================================================

describe('writeMasterPlaylist', () => {
	test('writes basic master playlist', () => {
		const playlist: MasterPlaylist = {
			type: 'master',
			version: 4,
			variants: [
				{ bandwidth: 1280000, uri: 'low/video.m3u8' },
				{ bandwidth: 2560000, uri: 'high/video.m3u8' },
			],
			media: [],
		};

		const output = writeMasterPlaylist(playlist);
		expect(output).toContain('#EXTM3U');
		expect(output).toContain('#EXT-X-VERSION:4');
		expect(output).toContain('#EXT-X-STREAM-INF:BANDWIDTH=1280000');
		expect(output).toContain('low/video.m3u8');
		expect(output).toContain('#EXT-X-STREAM-INF:BANDWIDTH=2560000');
		expect(output).toContain('high/video.m3u8');
	});

	test('writes variant stream with all attributes', () => {
		const playlist: MasterPlaylist = {
			type: 'master',
			version: 4,
			variants: [{
				bandwidth: 1280000,
				averageBandwidth: 1000000,
				codecs: 'avc1.640028,mp4a.40.2',
				resolution: { width: 1920, height: 1080 },
				frameRate: 30,
				hdcpLevel: 'TYPE-1',
				audio: 'audio-group',
				video: 'video-group',
				subtitles: 'subs',
				closedCaptions: 'cc',
				uri: 'video.m3u8',
			}],
			media: [],
		};

		const output = writeMasterPlaylist(playlist);
		expect(output).toContain('BANDWIDTH=1280000');
		expect(output).toContain('AVERAGE-BANDWIDTH=1000000');
		expect(output).toContain('CODECS="avc1.640028,mp4a.40.2"');
		expect(output).toContain('RESOLUTION=1920x1080');
		expect(output).toContain('FRAME-RATE=30');
		expect(output).toContain('HDCP-LEVEL=TYPE-1');
		expect(output).toContain('AUDIO="audio-group"');
		expect(output).toContain('VIDEO="video-group"');
		expect(output).toContain('SUBTITLES="subs"');
		expect(output).toContain('CLOSED-CAPTIONS="cc"');
	});

	test('writes CLOSED-CAPTIONS=NONE without quotes', () => {
		const playlist: MasterPlaylist = {
			type: 'master',
			version: 4,
			variants: [{
				bandwidth: 1280000,
				closedCaptions: 'NONE',
				uri: 'video.m3u8',
			}],
			media: [],
		};

		const output = writeMasterPlaylist(playlist);
		expect(output).toContain('CLOSED-CAPTIONS=NONE');
		expect(output).not.toContain('CLOSED-CAPTIONS="NONE"');
	});

	test('writes media renditions', () => {
		const playlist: MasterPlaylist = {
			type: 'master',
			version: 4,
			variants: [{ bandwidth: 1280000, uri: 'video.m3u8', audio: 'audio' }],
			media: [{
				type: 'AUDIO',
				groupId: 'audio',
				name: 'English',
				language: 'en',
				default: true,
				autoselect: true,
				uri: 'audio_en.m3u8',
			}],
		};

		const output = writeMasterPlaylist(playlist);
		expect(output).toContain('#EXT-X-MEDIA:');
		expect(output).toContain('TYPE=AUDIO');
		expect(output).toContain('GROUP-ID="audio"');
		expect(output).toContain('NAME="English"');
		expect(output).toContain('LANGUAGE="en"');
		expect(output).toContain('DEFAULT=YES');
		expect(output).toContain('AUTOSELECT=YES');
		expect(output).toContain('URI="audio_en.m3u8"');
	});

	test('writes independent segments', () => {
		const playlist: MasterPlaylist = {
			type: 'master',
			version: 4,
			independentSegments: true,
			variants: [{ bandwidth: 1280000, uri: 'video.m3u8' }],
			media: [],
		};

		const output = writeMasterPlaylist(playlist);
		expect(output).toContain('#EXT-X-INDEPENDENT-SEGMENTS');
	});

	test('writes session data', () => {
		const playlist: MasterPlaylist = {
			type: 'master',
			version: 4,
			variants: [{ bandwidth: 1280000, uri: 'video.m3u8' }],
			media: [],
			sessionData: [
				{ dataId: 'com.example.lyrics', value: 'Hello "World"' },
				{ dataId: 'com.example.config', uri: 'config.json', language: 'en' },
			],
		};

		const output = writeMasterPlaylist(playlist);
		expect(output).toContain('#EXT-X-SESSION-DATA:DATA-ID="com.example.lyrics",VALUE="Hello \\"World\\""');
		expect(output).toContain('URI="config.json"');
		expect(output).toContain('LANGUAGE="en"');
	});

	test('writes session key', () => {
		const playlist: MasterPlaylist = {
			type: 'master',
			version: 4,
			variants: [{ bandwidth: 1280000, uri: 'video.m3u8' }],
			media: [],
			sessionKey: {
				method: 'AES-128',
				uri: 'https://example.com/key.bin',
				iv: '1234567890ABCDEF1234567890ABCDEF',
			},
		};

		const output = writeMasterPlaylist(playlist);
		expect(output).toContain('#EXT-X-SESSION-KEY:');
		expect(output).toContain('METHOD=AES-128');
		expect(output).toContain('URI="https://example.com/key.bin"');
		expect(output).toContain('IV=0x1234567890ABCDEF1234567890ABCDEF');
	});

	test('omits version tag when version is 1', () => {
		const playlist: MasterPlaylist = {
			type: 'master',
			version: 1,
			variants: [{ bandwidth: 1280000, uri: 'video.m3u8' }],
			media: [],
		};

		const output = writeMasterPlaylist(playlist);
		expect(output).not.toContain('#EXT-X-VERSION');
	});
});

// ============================================================================
// Media Playlist Writer Tests
// ============================================================================

describe('writeMediaPlaylist', () => {
	test('writes basic media playlist', () => {
		const playlist: MediaPlaylist = {
			type: 'media',
			version: 3,
			targetDuration: 10,
			mediaSequence: 0,
			endList: true,
			segments: [
				{ duration: 9.009, uri: 'segment0.ts' },
				{ duration: 9.009, uri: 'segment1.ts' },
				{ duration: 3.003, uri: 'segment2.ts' },
			],
		};

		const output = writeMediaPlaylist(playlist);
		expect(output).toContain('#EXTM3U');
		expect(output).toContain('#EXT-X-VERSION:3');
		expect(output).toContain('#EXT-X-TARGETDURATION:10');
		expect(output).toContain('#EXTINF:9.009,');
		expect(output).toContain('segment0.ts');
		expect(output).toContain('#EXTINF:3.003,');
		expect(output).toContain('#EXT-X-ENDLIST');
	});

	test('omits media sequence when 0', () => {
		const playlist: MediaPlaylist = {
			type: 'media',
			version: 3,
			targetDuration: 10,
			mediaSequence: 0,
			endList: true,
			segments: [{ duration: 5, uri: 'segment.ts' }],
		};

		const output = writeMediaPlaylist(playlist);
		expect(output).not.toContain('#EXT-X-MEDIA-SEQUENCE');
	});

	test('writes media sequence when non-zero', () => {
		const playlist: MediaPlaylist = {
			type: 'media',
			version: 3,
			targetDuration: 10,
			mediaSequence: 100,
			endList: false,
			segments: [{ duration: 5, uri: 'segment.ts' }],
		};

		const output = writeMediaPlaylist(playlist);
		expect(output).toContain('#EXT-X-MEDIA-SEQUENCE:100');
	});

	test('writes segment with title', () => {
		const playlist: MediaPlaylist = {
			type: 'media',
			version: 3,
			targetDuration: 10,
			mediaSequence: 0,
			endList: true,
			segments: [{ duration: 5, title: 'Segment Title', uri: 'segment.ts' }],
		};

		const output = writeMediaPlaylist(playlist);
		expect(output).toContain('#EXTINF:5,Segment Title');
	});

	test('writes byte range', () => {
		const playlist: MediaPlaylist = {
			type: 'media',
			version: 4,
			targetDuration: 10,
			mediaSequence: 0,
			endList: true,
			segments: [
				{ duration: 5, uri: 'segment.ts', byteRange: { length: 1000, offset: 0 } },
				{ duration: 5, uri: 'segment.ts', byteRange: { length: 1000 } },
			],
		};

		const output = writeMediaPlaylist(playlist);
		expect(output).toContain('#EXT-X-BYTERANGE:1000@0');
		expect(output).toContain('#EXT-X-BYTERANGE:1000\n');
	});

	test('writes discontinuity', () => {
		const playlist: MediaPlaylist = {
			type: 'media',
			version: 3,
			targetDuration: 10,
			mediaSequence: 0,
			endList: true,
			segments: [
				{ duration: 5, uri: 'segment0.ts' },
				{ duration: 5, uri: 'segment1.ts', discontinuity: true },
			],
		};

		const output = writeMediaPlaylist(playlist);
		expect(output).toContain('#EXT-X-DISCONTINUITY');
	});

	test('writes encryption key and avoids duplicates', () => {
		const key: EncryptionKey = {
			method: 'AES-128',
			uri: 'https://example.com/key.bin',
			iv: '1234567890ABCDEF1234567890ABCDEF',
		};

		const playlist: MediaPlaylist = {
			type: 'media',
			version: 3,
			targetDuration: 10,
			mediaSequence: 0,
			endList: true,
			segments: [
				{ duration: 5, uri: 'segment0.ts', key },
				{ duration: 5, uri: 'segment1.ts', key }, // Same key, should not be repeated
				{ duration: 5, uri: 'segment2.ts' }, // No key, should write METHOD=NONE
			],
		};

		const output = writeMediaPlaylist(playlist);
		const keyMatches = output.match(/#EXT-X-KEY:METHOD=AES-128/g);
		expect(keyMatches).toHaveLength(1);
		expect(output).toContain('#EXT-X-KEY:METHOD=NONE');
	});

	test('writes init segment and avoids duplicates', () => {
		const map = { uri: 'init.mp4' };

		const playlist: MediaPlaylist = {
			type: 'media',
			version: 6,
			targetDuration: 10,
			mediaSequence: 0,
			endList: true,
			segments: [
				{ duration: 5, uri: 'segment0.m4s', map },
				{ duration: 5, uri: 'segment1.m4s', map }, // Same map, should not be repeated
				{ duration: 5, uri: 'segment2.m4s', map: { uri: 'init2.mp4', byteRange: { length: 1000, offset: 0 } } },
			],
		};

		const output = writeMediaPlaylist(playlist);
		const mapMatches = output.match(/#EXT-X-MAP:URI="init.mp4"/g);
		expect(mapMatches).toHaveLength(1);
		expect(output).toContain('#EXT-X-MAP:URI="init2.mp4",BYTERANGE="1000@0"');
	});

	test('writes program date time', () => {
		const playlist: MediaPlaylist = {
			type: 'media',
			version: 3,
			targetDuration: 10,
			mediaSequence: 0,
			endList: true,
			segments: [{
				duration: 5,
				uri: 'segment.ts',
				programDateTime: new Date('2021-01-15T12:30:00.000Z'),
			}],
		};

		const output = writeMediaPlaylist(playlist);
		expect(output).toContain('#EXT-X-PROGRAM-DATE-TIME:2021-01-15T12:30:00.000Z');
	});

	test('writes gap', () => {
		const playlist: MediaPlaylist = {
			type: 'media',
			version: 3,
			targetDuration: 10,
			mediaSequence: 0,
			endList: true,
			segments: [{ duration: 5, uri: 'segment.ts', gap: true }],
		};

		const output = writeMediaPlaylist(playlist);
		expect(output).toContain('#EXT-X-GAP');
	});

	test('writes bitrate', () => {
		const playlist: MediaPlaylist = {
			type: 'media',
			version: 3,
			targetDuration: 10,
			mediaSequence: 0,
			endList: true,
			segments: [{ duration: 5, uri: 'segment.ts', bitrate: 1500000 }],
		};

		const output = writeMediaPlaylist(playlist);
		expect(output).toContain('#EXT-X-BITRATE:1500');
	});

	test('writes playlist type', () => {
		const playlist: MediaPlaylist = {
			type: 'media',
			version: 3,
			targetDuration: 10,
			mediaSequence: 0,
			playlistType: 'VOD',
			endList: true,
			segments: [{ duration: 5, uri: 'segment.ts' }],
		};

		const output = writeMediaPlaylist(playlist);
		expect(output).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
	});

	test('writes I-frames only', () => {
		const playlist: MediaPlaylist = {
			type: 'media',
			version: 4,
			targetDuration: 10,
			mediaSequence: 0,
			iFramesOnly: true,
			endList: true,
			segments: [{ duration: 5, uri: 'iframe.ts' }],
		};

		const output = writeMediaPlaylist(playlist);
		expect(output).toContain('#EXT-X-I-FRAMES-ONLY');
	});

	test('writes discontinuity sequence', () => {
		const playlist: MediaPlaylist = {
			type: 'media',
			version: 3,
			targetDuration: 10,
			mediaSequence: 0,
			discontinuitySequence: 5,
			endList: true,
			segments: [{ duration: 5, uri: 'segment.ts' }],
		};

		const output = writeMediaPlaylist(playlist);
		expect(output).toContain('#EXT-X-DISCONTINUITY-SEQUENCE:5');
	});

	test('writes start tag', () => {
		const playlist: MediaPlaylist = {
			type: 'media',
			version: 3,
			targetDuration: 10,
			mediaSequence: 0,
			start: { timeOffset: 10.5, precise: true },
			endList: true,
			segments: [{ duration: 5, uri: 'segment.ts' }],
		};

		const output = writeMediaPlaylist(playlist);
		expect(output).toContain('#EXT-X-START:TIME-OFFSET=10.5,PRECISE=YES');
	});

	test('writes date ranges', () => {
		const playlist: MediaPlaylist = {
			type: 'media',
			version: 3,
			targetDuration: 10,
			mediaSequence: 0,
			endList: true,
			segments: [{ duration: 5, uri: 'segment.ts' }],
			dateRanges: [{
				id: 'ad-break',
				class: 'ad',
				startDate: new Date('2021-01-15T12:30:00Z'),
				endDate: new Date('2021-01-15T12:30:30Z'),
				duration: 30,
				plannedDuration: 30,
				endOnNext: true,
				clientAttributes: { 'X-CUSTOM-ATTR': 'value', 'X-NUMERIC': 123 },
			}],
		};

		const output = writeMediaPlaylist(playlist);
		expect(output).toContain('#EXT-X-DATERANGE:');
		expect(output).toContain('ID="ad-break"');
		expect(output).toContain('CLASS="ad"');
		expect(output).toContain('START-DATE="2021-01-15T12:30:00.000Z"');
		expect(output).toContain('END-DATE="2021-01-15T12:30:30.000Z"');
		expect(output).toContain('DURATION=30');
		expect(output).toContain('PLANNED-DURATION=30');
		expect(output).toContain('END-ON-NEXT=YES');
		expect(output).toContain('X-CUSTOM-ATTR="value"');
		expect(output).toContain('X-NUMERIC=123');
	});

	test('formats duration without trailing zeros', () => {
		const playlist: MediaPlaylist = {
			type: 'media',
			version: 3,
			targetDuration: 10,
			mediaSequence: 0,
			endList: true,
			segments: [
				{ duration: 5, uri: 'a.ts' },
				{ duration: 5.5, uri: 'b.ts' },
				{ duration: 5.123, uri: 'c.ts' },
				{ duration: 5.1234, uri: 'd.ts' }, // Should be truncated to 3 decimals
			],
		};

		const output = writeMediaPlaylist(playlist);
		expect(output).toContain('#EXTINF:5,');
		expect(output).toContain('#EXTINF:5.5,');
		expect(output).toContain('#EXTINF:5.123,');
		expect(output).toContain('#EXTINF:5.123,'); // Rounded
	});

	test('omits endlist when false', () => {
		const playlist: MediaPlaylist = {
			type: 'media',
			version: 3,
			targetDuration: 10,
			mediaSequence: 100,
			endList: false,
			segments: [{ duration: 5, uri: 'segment.ts' }],
		};

		const output = writeMediaPlaylist(playlist);
		expect(output).not.toContain('#EXT-X-ENDLIST');
	});
});

// ============================================================================
// Round-Trip Tests
// ============================================================================

describe('round-trip parsing and writing', () => {
	test('master playlist round-trip', () => {
		const original: MasterPlaylist = {
			type: 'master',
			version: 4,
			independentSegments: true,
			variants: [
				{
					bandwidth: 1280000,
					averageBandwidth: 1000000,
					codecs: 'avc1.640028,mp4a.40.2',
					resolution: { width: 1920, height: 1080 },
					frameRate: 30,
					audio: 'audio',
					uri: 'video.m3u8',
				},
			],
			media: [
				{
					type: 'AUDIO',
					groupId: 'audio',
					name: 'English',
					language: 'en',
					default: true,
					autoselect: true,
					uri: 'audio_en.m3u8',
				},
			],
		};

		const written = writeMasterPlaylist(original);
		const parsed = parseMasterPlaylist(written);

		expect(parsed.version).toBe(original.version);
		expect(parsed.independentSegments).toBe(original.independentSegments);
		expect(parsed.variants).toHaveLength(1);
		expect(parsed.variants[0]!.bandwidth).toBe(original.variants[0]!.bandwidth);
		expect(parsed.variants[0]!.resolution).toEqual(original.variants[0]!.resolution);
		expect(parsed.media).toHaveLength(1);
		expect(parsed.media[0]!.name).toBe(original.media[0]!.name);
	});

	test('media playlist round-trip', () => {
		const original: MediaPlaylist = {
			type: 'media',
			version: 6,
			targetDuration: 10,
			mediaSequence: 100,
			discontinuitySequence: 5,
			playlistType: 'EVENT',
			independentSegments: true,
			endList: false,
			start: { timeOffset: 10.5 },
			segments: [
				{
					duration: 9.009,
					uri: 'segment100.m4s',
					map: { uri: 'init.mp4' },
					key: { method: 'AES-128', uri: 'key.bin' },
				},
				{
					duration: 9.009,
					uri: 'segment101.m4s',
					map: { uri: 'init.mp4' },
					key: { method: 'AES-128', uri: 'key.bin' },
					programDateTime: new Date('2021-01-15T12:30:00.000Z'),
				},
				{
					duration: 9.009,
					uri: 'segment102.m4s',
					map: { uri: 'init.mp4' },
					key: { method: 'AES-128', uri: 'key.bin' },
					discontinuity: true,
				},
			],
		};

		const written = writeMediaPlaylist(original);
		const parsed = parseMediaPlaylist(written);

		expect(parsed.version).toBe(original.version);
		expect(parsed.targetDuration).toBe(original.targetDuration);
		expect(parsed.mediaSequence).toBe(original.mediaSequence);
		expect(parsed.discontinuitySequence).toBe(original.discontinuitySequence);
		expect(parsed.playlistType).toBe(original.playlistType);
		expect(parsed.independentSegments).toBe(original.independentSegments);
		expect(parsed.endList).toBe(original.endList);
		expect(parsed.start!.timeOffset).toBe(original.start!.timeOffset);
		expect(parsed.segments).toHaveLength(3);
		expect(parsed.segments[0]!.duration).toBeCloseTo(original.segments[0]!.duration, 3);
		expect(parsed.segments[0]!.map!.uri).toBe(original.segments[0]!.map!.uri);
		expect(parsed.segments[0]!.key!.method).toBe(original.segments[0]!.key!.method);
		expect(parsed.segments[1]!.programDateTime).toEqual(original.segments[1]!.programDateTime);
		expect(parsed.segments[2]!.discontinuity).toBe(original.segments[2]!.discontinuity);
	});
});

// ============================================================================
// writePlaylist Tests
// ============================================================================

describe('writePlaylist', () => {
	test('writes master playlist via union type', () => {
		const playlist: MasterPlaylist = {
			type: 'master',
			version: 4,
			variants: [{ bandwidth: 1280000, uri: 'video.m3u8' }],
			media: [],
		};

		const output = writePlaylist(playlist);
		expect(output).toContain('#EXT-X-STREAM-INF');
	});

	test('writes media playlist via union type', () => {
		const playlist: MediaPlaylist = {
			type: 'media',
			version: 3,
			targetDuration: 10,
			mediaSequence: 0,
			endList: true,
			segments: [{ duration: 5, uri: 'segment.ts' }],
		};

		const output = writePlaylist(playlist);
		expect(output).toContain('#EXT-X-TARGETDURATION');
		expect(output).toContain('#EXTINF');
	});
});
