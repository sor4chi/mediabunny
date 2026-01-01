import { describe, it, expect, vi } from 'vitest';
import { HlsInput } from '../../src/hls/hls-input.js';

describe('HlsInput', () => {
	describe('constructor', () => {
		it('should create with valid manifest URL', () => {
			expect(() => new HlsInput('https://example.com/master.m3u8')).not.toThrow();
		});

		it('should throw on empty URL', () => {
			expect(() => new HlsInput('')).toThrow(TypeError);
		});

		it('should throw on non-string URL', () => {
			expect(() => new HlsInput(null as unknown as string)).toThrow(TypeError);
			expect(() => new HlsInput(undefined as unknown as string)).toThrow(TypeError);
			expect(() => new HlsInput(123 as unknown as string)).toThrow(TypeError);
		});

		it('should accept custom fetch function', () => {
			const customFetch = vi.fn();
			expect(() => new HlsInput('https://example.com/master.m3u8', { fetch: customFetch })).not.toThrow();
		});
	});

	describe('dispose', () => {
		it('should mark as disposed', () => {
			const input = new HlsInput('https://example.com/master.m3u8');
			expect(input.disposed).toBe(false);
			input.dispose();
			expect(input.disposed).toBe(true);
		});

		it('should be idempotent', () => {
			const input = new HlsInput('https://example.com/master.m3u8');
			input.dispose();
			expect(() => input.dispose()).not.toThrow();
			expect(input.disposed).toBe(true);
		});

		it('should support Symbol.dispose', () => {
			const input = new HlsInput('https://example.com/master.m3u8');
			expect(typeof input[Symbol.dispose]).toBe('function');
			input[Symbol.dispose]();
			expect(input.disposed).toBe(true);
		});
	});

	describe('master playlist parsing', () => {
		const createMasterPlaylist = (variants: Array<{ bandwidth: number; resolution?: string; uri: string }>) => {
			let content = '#EXTM3U\n#EXT-X-VERSION:7\n';
			for (const v of variants) {
				let attrs = `BANDWIDTH=${v.bandwidth}`;
				if (v.resolution) {
					attrs += `,RESOLUTION=${v.resolution}`;
				}
				content += `#EXT-X-STREAM-INF:${attrs}\n${v.uri}\n`;
			}
			return content;
		};

		it('should parse master playlist and list variants', async () => {
			const masterContent = createMasterPlaylist([
				{ bandwidth: 1000000, resolution: '1920x1080', uri: 'high.m3u8' },
				{ bandwidth: 500000, resolution: '1280x720', uri: 'medium.m3u8' },
				{ bandwidth: 200000, resolution: '640x360', uri: 'low.m3u8' },
			]);

			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				text: () => Promise.resolve(masterContent),
			});

			const input = new HlsInput('https://example.com/master.m3u8', { fetch: mockFetch });
			const variants = await input.getVariants();

			expect(variants).toHaveLength(3);
			expect(variants[0]!.bandwidth).toBe(1000000);
			expect(variants[0]!.resolution).toEqual({ width: 1920, height: 1080 });
			expect(variants[1]!.bandwidth).toBe(500000);
			expect(variants[2]!.bandwidth).toBe(200000);
		});

		it('should auto-select highest bandwidth variant', async () => {
			const masterContent = createMasterPlaylist([
				{ bandwidth: 500000, uri: 'medium.m3u8' },
				{ bandwidth: 1000000, uri: 'high.m3u8' },
				{ bandwidth: 200000, uri: 'low.m3u8' },
			]);

			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				text: () => Promise.resolve(masterContent),
			});

			const input = new HlsInput('https://example.com/master.m3u8', { fetch: mockFetch });
			const selected = await input.getSelectedVariant();

			expect(selected).not.toBeNull();
			expect(selected!.bandwidth).toBe(1000000);
			expect(selected!.uri).toBe('high.m3u8');
		});

		it('should allow selecting a specific variant', async () => {
			const masterContent = createMasterPlaylist([
				{ bandwidth: 1000000, uri: 'high.m3u8' },
				{ bandwidth: 500000, uri: 'medium.m3u8' },
			]);

			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				text: () => Promise.resolve(masterContent),
			});

			const input = new HlsInput('https://example.com/master.m3u8', { fetch: mockFetch });
			const variants = await input.getVariants();

			await input.selectVariant(variants[1]!);
			const selected = await input.getSelectedVariant();

			expect(selected!.bandwidth).toBe(500000);
		});

		it('should throw when selecting invalid variant', async () => {
			const masterContent = createMasterPlaylist([
				{ bandwidth: 1000000, uri: 'high.m3u8' },
			]);

			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				text: () => Promise.resolve(masterContent),
			});

			const input = new HlsInput('https://example.com/master.m3u8', { fetch: mockFetch });
			await input.getVariants();

			const fakeVariant = { bandwidth: 999, uri: 'fake.m3u8' };
			await expect(input.selectVariant(fakeVariant)).rejects.toThrow('Invalid variant');
		});
	});

	describe('media playlist (no master)', () => {
		const createMediaPlaylist = (segments: number, hasEndlist = true) => {
			let content = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n';
			content += '#EXT-X-MAP:URI="init.mp4"\n';
			for (let i = 0; i < segments; i++) {
				content += `#EXTINF:6.0,\nseg${i}.mp4\n`;
			}
			if (hasEndlist) {
				content += '#EXT-X-ENDLIST\n';
			}
			return content;
		};

		it('should return empty variants for media playlist', async () => {
			const mediaContent = createMediaPlaylist(3);

			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				text: () => Promise.resolve(mediaContent),
			});

			const input = new HlsInput('https://example.com/media.m3u8', { fetch: mockFetch });
			const variants = await input.getVariants();

			expect(variants).toHaveLength(0);
		});

		it('should return null for selected variant on media playlist', async () => {
			const mediaContent = createMediaPlaylist(3);

			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				text: () => Promise.resolve(mediaContent),
			});

			const input = new HlsInput('https://example.com/media.m3u8', { fetch: mockFetch });
			const selected = await input.getSelectedVariant();

			expect(selected).toBeNull();
		});
	});

	describe('live stream detection', () => {
		it('should detect VOD stream (has ENDLIST)', async () => {
			const mediaContent = [
				'#EXTM3U',
				'#EXT-X-VERSION:7',
				'#EXT-X-TARGETDURATION:6',
				'#EXT-X-MAP:URI="init.mp4"',
				'#EXTINF:6.0,',
				'seg0.mp4',
				'#EXT-X-ENDLIST',
			].join('\n');

			let fetchCount = 0;
			const mockFetch = vi.fn().mockImplementation(() => {
				fetchCount++;
				if (fetchCount === 1) {
					return Promise.resolve({
						ok: true,
						text: () => Promise.resolve(mediaContent),
					});
				}
				// For init segment
				return Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: () => Promise.resolve(new Uint8Array(100).buffer),
				});
			});

			const input = new HlsInput('https://example.com/vod.m3u8', { fetch: mockFetch });
			const isLive = await input.isLive();

			expect(isLive).toBe(false);
		});

		it('should detect live stream (no ENDLIST)', async () => {
			const mediaContent = [
				'#EXTM3U',
				'#EXT-X-VERSION:7',
				'#EXT-X-TARGETDURATION:6',
				'#EXT-X-MAP:URI="init.mp4"',
				'#EXTINF:6.0,',
				'seg0.mp4',
				// No #EXT-X-ENDLIST
			].join('\n');

			let fetchCount = 0;
			const mockFetch = vi.fn().mockImplementation(() => {
				fetchCount++;
				if (fetchCount === 1) {
					return Promise.resolve({
						ok: true,
						text: () => Promise.resolve(mediaContent),
					});
				}
				return Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: () => Promise.resolve(new Uint8Array(100).buffer),
				});
			});

			const input = new HlsInput('https://example.com/live.m3u8', { fetch: mockFetch });
			const isLive = await input.isLive();

			expect(isLive).toBe(true);
		});
	});

	describe('duration computation', () => {
		it('should compute duration from segment durations', async () => {
			const mediaContent = [
				'#EXTM3U',
				'#EXT-X-VERSION:7',
				'#EXT-X-TARGETDURATION:6',
				'#EXT-X-MAP:URI="init.mp4"',
				'#EXTINF:6.0,',
				'seg0.mp4',
				'#EXTINF:5.5,',
				'seg1.mp4',
				'#EXTINF:4.0,',
				'seg2.mp4',
				'#EXT-X-ENDLIST',
			].join('\n');

			let fetchCount = 0;
			const mockFetch = vi.fn().mockImplementation(() => {
				fetchCount++;
				if (fetchCount === 1) {
					return Promise.resolve({
						ok: true,
						text: () => Promise.resolve(mediaContent),
					});
				}
				return Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: () => Promise.resolve(new Uint8Array(100).buffer),
				});
			});

			const input = new HlsInput('https://example.com/vod.m3u8', { fetch: mockFetch });
			const duration = await input.computeDuration();

			expect(duration).toBe(15.5); // 6 + 5.5 + 4
		});

		it('should return Infinity for live streams', async () => {
			const mediaContent = [
				'#EXTM3U',
				'#EXT-X-VERSION:7',
				'#EXT-X-TARGETDURATION:6',
				'#EXT-X-MAP:URI="init.mp4"',
				'#EXTINF:6.0,',
				'seg0.mp4',
				// No ENDLIST = live
			].join('\n');

			let fetchCount = 0;
			const mockFetch = vi.fn().mockImplementation(() => {
				fetchCount++;
				if (fetchCount === 1) {
					return Promise.resolve({
						ok: true,
						text: () => Promise.resolve(mediaContent),
					});
				}
				return Promise.resolve({
					ok: true,
					status: 200,
					arrayBuffer: () => Promise.resolve(new Uint8Array(100).buffer),
				});
			});

			const input = new HlsInput('https://example.com/live.m3u8', { fetch: mockFetch });
			const duration = await input.computeDuration();

			expect(duration).toBe(Infinity);
		});
	});

	describe('error handling', () => {
		it('should throw on fetch failure', async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 404,
				statusText: 'Not Found',
			});

			const input = new HlsInput('https://example.com/missing.m3u8', { fetch: mockFetch });

			await expect(input.getVariants()).rejects.toThrow('Failed to fetch HLS manifest');
		});

		it('should throw on network error', async () => {
			const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));

			const input = new HlsInput('https://example.com/error.m3u8', { fetch: mockFetch });

			await expect(input.getVariants()).rejects.toThrow('Network error');
		});

		it('should throw on invalid playlist', async () => {
			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				text: () => Promise.resolve('not a valid playlist'),
			});

			const input = new HlsInput('https://example.com/invalid.m3u8', { fetch: mockFetch });

			await expect(input.getVariants()).rejects.toThrow();
		});
	});

	describe('URL resolution', () => {
		it('should resolve variant URLs relative to master', async () => {
			const masterContent = [
				'#EXTM3U',
				'#EXT-X-VERSION:7',
				'#EXT-X-STREAM-INF:BANDWIDTH=1000000',
				'variants/high/stream.m3u8',
			].join('\n');

			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				text: () => Promise.resolve(masterContent),
			});

			const input = new HlsInput('https://example.com/hls/master.m3u8', { fetch: mockFetch });
			const variants = await input.getVariants();

			expect(variants[0]!.uri).toBe('variants/high/stream.m3u8');
		});
	});

	describe('initialization caching', () => {
		it('should only fetch manifest once for multiple calls', async () => {
			const masterContent = [
				'#EXTM3U',
				'#EXT-X-VERSION:7',
				'#EXT-X-STREAM-INF:BANDWIDTH=1000000',
				'high.m3u8',
			].join('\n');

			const mockFetch = vi.fn().mockResolvedValue({
				ok: true,
				text: () => Promise.resolve(masterContent),
			});

			const input = new HlsInput('https://example.com/master.m3u8', { fetch: mockFetch });

			await input.getVariants();
			await input.getSelectedVariant();
			await input.getVariants();

			expect(mockFetch).toHaveBeenCalledTimes(1);
		});
	});
});
