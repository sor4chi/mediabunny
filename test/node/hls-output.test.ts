/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { describe, it, expect } from 'vitest';
import {
	HlsOutputFormat,
	HlsBufferTarget,
	HlsCallbackTarget,
	HlsSource,
	parseMediaPlaylist,
	type HlsSegmentInfo,
} from '../../src/hls/index.js';

describe('HlsOutputFormat', () => {
	describe('constructor', () => {
		it('should create with default options', () => {
			// Just verify it doesn't throw with no options
			expect(() => new HlsOutputFormat()).not.toThrow();
		});

		it('should create with custom options', () => {
			// Verify it accepts all valid options
			expect(() => new HlsOutputFormat({
				segmentDuration: 4,
				playlistType: 'VOD',
				segmentFilePattern: 'seg_{number}.m4s',
				initSegmentFileName: 'header.mp4',
				playlistFileName: 'stream.m3u8',
				maxSegmentCount: 10,
			})).not.toThrow();
		});

		it('should throw on invalid options', () => {
			expect(() => new HlsOutputFormat(null as unknown as object)).toThrow(TypeError);
			expect(() => new HlsOutputFormat({ segmentDuration: -1 })).toThrow(TypeError);
			expect(() => new HlsOutputFormat({ segmentDuration: 0 })).toThrow(TypeError);
			expect(() => new HlsOutputFormat({ playlistType: 'INVALID' as 'VOD' })).toThrow(TypeError);
			expect(() => new HlsOutputFormat({ segmentFilePattern: 123 as unknown as string })).toThrow(TypeError);
			expect(() => new HlsOutputFormat({ maxSegmentCount: 0 })).toThrow(TypeError);
			expect(() => new HlsOutputFormat({ maxSegmentCount: 1.5 })).toThrow(TypeError);
		});
	});

	describe('properties', () => {
		it('should return correct file extension', () => {
			const format = new HlsOutputFormat();
			expect(format.fileExtension).toBe('.m3u8');
		});

		it('should return correct mime type', () => {
			const format = new HlsOutputFormat();
			expect(format.mimeType).toBe('application/vnd.apple.mpegurl');
		});

		it('should support video rotation metadata', () => {
			const format = new HlsOutputFormat();
			expect(format.supportsVideoRotationMetadata).toBe(true);
		});

		it('should return supported codecs', () => {
			const format = new HlsOutputFormat();
			const codecs = format.getSupportedCodecs();
			expect(codecs).toContain('avc'); // H.264
			expect(codecs).toContain('hevc');
			expect(codecs).toContain('av1');
			expect(codecs).toContain('aac');
			expect(codecs).toContain('opus');
		});

		it('should return supported track counts', () => {
			const format = new HlsOutputFormat();
			const counts = format.getSupportedTrackCounts();
			expect(counts.video.min).toBe(0);
			expect(counts.video.max).toBe(1);
			expect(counts.audio.min).toBe(0);
			expect(counts.audio.max).toBe(Infinity);
			expect(counts.total.min).toBe(1);
		});
	});
});

describe('HlsBufferTarget', () => {
	it('should create successfully', () => {
		expect(() => new HlsBufferTarget()).not.toThrow();
	});

	it('should expose files map and helper methods', () => {
		const target = new HlsBufferTarget();
		expect(target.files).toBeInstanceOf(Map);
		expect(target.getFileNames()).toEqual([]);
		expect(target.getFile('nonexistent')).toBeUndefined();
	});

	it('should track files through the files map', () => {
		const target = new HlsBufferTarget();

		// Directly manipulate the files map (simulating what _write* methods do)
		target.files.set('init.mp4', new Uint8Array([1, 2, 3, 4]));
		target.files.set('playlist.m3u8', '#EXTM3U\n');
		target.files.set('segment0.m4s', new Uint8Array([5, 6, 7, 8]));

		expect(target.getFileNames()).toHaveLength(3);
		expect(target.getFileNames()).toContain('init.mp4');
		expect(target.getFileNames()).toContain('playlist.m3u8');
		expect(target.getFileNames()).toContain('segment0.m4s');

		expect(target.getFile('init.mp4')).toEqual(new Uint8Array([1, 2, 3, 4]));
		expect(target.getFile('playlist.m3u8')).toBe('#EXTM3U\n');
	});
});

describe('HlsCallbackTarget', () => {
	it('should create with empty options', () => {
		expect(() => new HlsCallbackTarget()).not.toThrow();
		expect(() => new HlsCallbackTarget({})).not.toThrow();
	});

	it('should create with callbacks', () => {
		expect(() => new HlsCallbackTarget({
			onInitSegment: () => {},
			onSegment: () => {},
			onSegmentRemove: () => {},
			onPlaylist: () => {},
			onFinalize: () => {},
		})).not.toThrow();
	});

	it('should accept async callbacks', () => {
		expect(() => new HlsCallbackTarget({
			onInitSegment: async () => {},
			onSegment: async () => {},
			onSegmentRemove: async () => {},
			onPlaylist: async () => {},
			onFinalize: async () => {},
		})).not.toThrow();
	});
});

describe('HLS Integration', () => {
	it('should be able to parse a valid HLS playlist', () => {
		// Test that the M3U8 parser can handle a typical HLS media playlist
		const playlistContent = [
			'#EXTM3U',
			'#EXT-X-VERSION:6',
			'#EXT-X-TARGETDURATION:6',
			'#EXT-X-MAP:URI="init.mp4"',
			'#EXTINF:6,',
			'segment0.m4s',
			'#EXTINF:6,',
			'segment1.m4s',
			'#EXT-X-ENDLIST',
			'',
		].join('\n');

		const playlist = parseMediaPlaylist(playlistContent);
		expect(playlist.version).toBe(6);
		expect(playlist.targetDuration).toBe(6);
		expect(playlist.segments).toHaveLength(2);
		expect(playlist.segments[0]?.uri).toBe('segment0.m4s');
		expect(playlist.segments[0]?.map?.uri).toBe('init.mp4');
		expect(playlist.segments[1]?.uri).toBe('segment1.m4s');
		expect(playlist.endList).toBe(true);
	});

	it('should be able to represent HLS segment info', () => {
		const segment: HlsSegmentInfo = {
			number: 0,
			timestamp: 0,
			duration: 6.0,
			fileName: 'segment0.m4s',
			data: new Uint8Array([1, 2, 3, 4]),
		};

		// Verify the type structure
		expect(segment.number).toBe(0);
		expect(segment.timestamp).toBe(0);
		expect(segment.duration).toBe(6.0);
		expect(segment.fileName).toBe('segment0.m4s');
		expect(segment.data).toEqual(new Uint8Array([1, 2, 3, 4]));
	});
});

describe('HlsSource', () => {
	describe('constructor', () => {
		it('should create with valid manifest URL', () => {
			expect(() => new HlsSource('https://example.com/stream.m3u8')).not.toThrow();
		});

		it('should create with options', () => {
			expect(() => new HlsSource('https://example.com/stream.m3u8', {
				qualitySelection: 'highest',
			})).not.toThrow();
			expect(() => new HlsSource('https://example.com/stream.m3u8', {
				qualitySelection: 'lowest',
			})).not.toThrow();
			expect(() => new HlsSource('https://example.com/stream.m3u8', {
				qualitySelection: 'auto',
			})).not.toThrow();
			expect(() => new HlsSource('https://example.com/stream.m3u8', {
				qualitySelection: { bandwidth: 5000000 },
			})).not.toThrow();
			expect(() => new HlsSource('https://example.com/stream.m3u8', {
				qualitySelection: { resolution: { width: 1920, height: 1080 } },
			})).not.toThrow();
		});

		it('should throw on invalid manifest URL', () => {
			expect(() => new HlsSource(null as unknown as string)).toThrow(TypeError);
			expect(() => new HlsSource(123 as unknown as string)).toThrow(TypeError);
		});

		it('should throw on invalid options', () => {
			expect(
				() => new HlsSource('https://example.com/stream.m3u8', null as unknown as object),
			).toThrow(TypeError);
		});
	});

	describe('state management', () => {
		it('should track disposed state', () => {
			const source = new HlsSource('https://example.com/stream.m3u8');
			expect(source.isDisposed()).toBe(false);
			source.dispose();
			expect(source.isDisposed()).toBe(true);
		});

		it('should return null for unresolved stream', () => {
			const source = new HlsSource('https://example.com/stream.m3u8');
			expect(source.getResolvedStream()).toBeNull();
		});

		it('should throw when resolving disposed source', async () => {
			const source = new HlsSource('https://example.com/stream.m3u8');
			source.dispose();
			await expect(source.resolve()).rejects.toThrow('disposed');
		});
	});

	describe('with mock fetch', () => {
		it('should resolve a media playlist', async () => {
			const mediaPlaylist = [
				'#EXTM3U',
				'#EXT-X-VERSION:6',
				'#EXT-X-TARGETDURATION:6',
				'#EXT-X-MAP:URI="init.mp4"',
				'#EXTINF:6,',
				'segment0.m4s',
				'#EXT-X-ENDLIST',
				'',
			].join('\n');

			const mockFetch = async () => new Response(mediaPlaylist, {
				status: 200,
				headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
			});

			const source = new HlsSource('https://example.com/stream/playlist.m3u8', {
				fetchFn: mockFetch,
			});

			const resolved = await source.resolve();
			expect(resolved.mediaPlaylist.version).toBe(6);
			expect(resolved.mediaPlaylist.targetDuration).toBe(6);
			expect(resolved.mediaPlaylist.segments).toHaveLength(1);
			expect(resolved.baseUrl).toBe('https://example.com/stream/');
		});

		it('should resolve a master playlist and select highest bandwidth', async () => {
			const masterPlaylist = [
				'#EXTM3U',
				'#EXT-X-VERSION:3',
				'#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360',
				'low.m3u8',
				'#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720',
				'high.m3u8',
				'',
			].join('\n');

			const mediaPlaylist = [
				'#EXTM3U',
				'#EXT-X-VERSION:6',
				'#EXT-X-TARGETDURATION:6',
				'#EXTINF:6,',
				'segment0.m4s',
				'#EXT-X-ENDLIST',
				'',
			].join('\n');

			let fetchCount = 0;
			const mockFetch: typeof fetch = async (input) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
				fetchCount++;
				if (fetchCount === 1) {
					// First fetch: master playlist
					return new Response(masterPlaylist, { status: 200 });
				} else {
					// Second fetch: media playlist (should be high.m3u8)
					expect(url).toContain('high.m3u8');
					return new Response(mediaPlaylist, { status: 200 });
				}
			};

			const source = new HlsSource('https://example.com/master.m3u8', {
				fetchFn: mockFetch,
				qualitySelection: 'highest',
			});

			const resolved = await source.resolve();
			expect(resolved.masterPlaylist).toBeDefined();
			expect(resolved.selectedVariant?.bandwidth).toBe(3000000);
			expect(fetchCount).toBe(2);
		});

		it('should select lowest bandwidth when configured', async () => {
			const masterPlaylist = [
				'#EXTM3U',
				'#EXT-X-VERSION:3',
				'#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360',
				'low.m3u8',
				'#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720',
				'high.m3u8',
				'',
			].join('\n');

			const mediaPlaylist = [
				'#EXTM3U',
				'#EXT-X-VERSION:6',
				'#EXT-X-TARGETDURATION:6',
				'#EXTINF:6,',
				'segment0.m4s',
				'#EXT-X-ENDLIST',
				'',
			].join('\n');

			let fetchedUrl = '';
			const mockFetch: typeof fetch = async (input) => {
				const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
				fetchedUrl = url;
				if (url.includes('master.m3u8')) {
					return new Response(masterPlaylist, { status: 200 });
				}
				return new Response(mediaPlaylist, { status: 200 });
			};

			const source = new HlsSource('https://example.com/master.m3u8', {
				fetchFn: mockFetch,
				qualitySelection: 'lowest',
			});

			const resolved = await source.resolve();
			expect(resolved.selectedVariant?.bandwidth).toBe(1000000);
			expect(fetchedUrl).toContain('low.m3u8');
		});
	});
});

describe('HlsInputFormat', () => {
	it('should have correct name and mimeType', async () => {
		const { HLS_INPUT } = await import('../../src/hls/index.js');
		expect(HLS_INPUT.name).toBe('HLS');
		expect(HLS_INPUT.mimeType).toBe('application/vnd.apple.mpegurl');
	});
});

describe('HlsVirtualSource', () => {
	it('should create successfully', async () => {
		const { HlsSource, HlsVirtualSource } = await import('../../src/hls/index.js');
		const hlsSource = new HlsSource('https://example.com/stream.m3u8');
		expect(() => new HlsVirtualSource(hlsSource)).not.toThrow();
	});

	it('should throw on invalid hlsSource', async () => {
		const { HlsVirtualSource } = await import('../../src/hls/index.js');
		expect(() => new HlsVirtualSource(null as never)).toThrow(TypeError);
	});

	it('should expose getHlsSource method', async () => {
		const { HlsSource, HlsVirtualSource } = await import('../../src/hls/index.js');
		const hlsSource = new HlsSource('https://example.com/stream.m3u8');
		const virtualSource = new HlsVirtualSource(hlsSource);
		expect(virtualSource.getHlsSource()).toBe(hlsSource);
	});

	it('should have _isHlsVirtualSource marker', async () => {
		const { HlsSource, HlsVirtualSource } = await import('../../src/hls/index.js');
		const hlsSource = new HlsSource('https://example.com/stream.m3u8');
		const virtualSource = new HlsVirtualSource(hlsSource);
		expect(virtualSource._isHlsVirtualSource).toBe(true);
	});
});

describe('createHlsVirtualSource', () => {
	it('should create HlsVirtualSource from URL', async () => {
		const { createHlsVirtualSource, HlsVirtualSource } = await import('../../src/hls/index.js');
		const source = createHlsVirtualSource('https://example.com/stream.m3u8');
		expect(source).toBeInstanceOf(HlsVirtualSource);
		expect(source._isHlsVirtualSource).toBe(true);
	});

	it('should pass options to HlsSource', async () => {
		const { createHlsVirtualSource } = await import('../../src/hls/index.js');
		// Just verify it doesn't throw with options
		expect(() => createHlsVirtualSource('https://example.com/stream.m3u8', {
			qualitySelection: 'highest',
			maxCachedSegments: 5,
		})).not.toThrow();
	});
});

describe('Live Streaming', () => {
	describe('HlsSource live detection', () => {
		it('should detect VOD stream (has #EXT-X-ENDLIST)', async () => {
			const { HlsSource } = await import('../../src/hls/index.js');

			const vodPlaylist = [
				'#EXTM3U',
				'#EXT-X-VERSION:6',
				'#EXT-X-TARGETDURATION:6',
				'#EXT-X-PLAYLIST-TYPE:VOD',
				'#EXTINF:6,',
				'segment0.m4s',
				'#EXT-X-ENDLIST',
				'',
			].join('\n');

			const mockFetch: typeof fetch = async () => new Response(vodPlaylist, { status: 200 });

			const source = new HlsSource('https://example.com/vod.m3u8', {
				fetchFn: mockFetch,
			});

			const resolved = await source.resolve();
			expect(resolved.isLive).toBe(false);
			expect(source.isLive()).toBe(false);
		});

		it('should detect live stream (no #EXT-X-ENDLIST)', async () => {
			const { HlsSource } = await import('../../src/hls/index.js');

			const livePlaylist = [
				'#EXTM3U',
				'#EXT-X-VERSION:6',
				'#EXT-X-TARGETDURATION:6',
				'#EXT-X-MEDIA-SEQUENCE:100',
				'#EXTINF:6,',
				'segment100.m4s',
				'#EXTINF:6,',
				'segment101.m4s',
				'', // No #EXT-X-ENDLIST
			].join('\n');

			const mockFetch: typeof fetch = async () => new Response(livePlaylist, { status: 200 });

			const source = new HlsSource('https://example.com/live.m3u8', {
				fetchFn: mockFetch,
			});

			const resolved = await source.resolve();
			expect(resolved.isLive).toBe(true);
			expect(source.isLive()).toBe(true);
		});

		it('should return null for isLive() before resolve', async () => {
			const { HlsSource } = await import('../../src/hls/index.js');
			const source = new HlsSource('https://example.com/stream.m3u8');
			expect(source.isLive()).toBeNull();
		});
	});

	describe('HlsSource refreshPlaylist', () => {
		it('should refresh live playlist', async () => {
			const { HlsSource } = await import('../../src/hls/index.js');

			let fetchCount = 0;
			const mockFetch: typeof fetch = async () => {
				fetchCount++;
				const playlist = [
					'#EXTM3U',
					'#EXT-X-VERSION:6',
					'#EXT-X-TARGETDURATION:6',
					`#EXT-X-MEDIA-SEQUENCE:${100 + fetchCount}`,
					'#EXTINF:6,',
					`segment${100 + fetchCount}.m4s`,
					'',
				].join('\n');
				return new Response(playlist, { status: 200 });
			};

			const source = new HlsSource('https://example.com/live.m3u8', {
				fetchFn: mockFetch,
			});

			await source.resolve();
			expect(fetchCount).toBe(1);

			const refreshed = await source.refreshPlaylist();
			expect(fetchCount).toBe(2);
			expect(refreshed.mediaPlaylist.mediaSequence).toBe(102);
		});

		it('should not refetch VOD playlists', async () => {
			const { HlsSource } = await import('../../src/hls/index.js');

			let fetchCount = 0;
			const mockFetch: typeof fetch = async () => {
				fetchCount++;
				return new Response([
					'#EXTM3U',
					'#EXT-X-VERSION:6',
					'#EXT-X-TARGETDURATION:6',
					'#EXT-X-PLAYLIST-TYPE:VOD',
					'#EXTINF:6,',
					'segment0.m4s',
					'#EXT-X-ENDLIST',
					'',
				].join('\n'), { status: 200 });
			};

			const source = new HlsSource('https://example.com/vod.m3u8', {
				fetchFn: mockFetch,
			});

			await source.resolve();
			expect(fetchCount).toBe(1);

			await source.refreshPlaylist();
			expect(fetchCount).toBe(1); // Should not have fetched again
		});

		it('should throw if called before resolve', async () => {
			const { HlsSource } = await import('../../src/hls/index.js');
			const source = new HlsSource('https://example.com/stream.m3u8');
			await expect(source.refreshPlaylist()).rejects.toThrow('not been resolved');
		});
	});

	describe('HlsOutputFormat live options', () => {
		it('should support EVENT playlist type', async () => {
			const { HlsOutputFormat } = await import('../../src/hls/index.js');
			expect(() => new HlsOutputFormat({ playlistType: 'EVENT' })).not.toThrow();
		});

		it('should support undefined playlist type for live', async () => {
			const { HlsOutputFormat } = await import('../../src/hls/index.js');
			const format = new HlsOutputFormat({ playlistType: undefined });
			expect(format._options.playlistType).toBeUndefined();
		});

		it('should support maxSegmentCount for sliding window', async () => {
			const { HlsOutputFormat } = await import('../../src/hls/index.js');
			const format = new HlsOutputFormat({ maxSegmentCount: 10 });
			expect(format._options.maxSegmentCount).toBe(10);
		});
	});
});
