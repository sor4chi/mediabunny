import { expect, test, describe } from 'vitest';
import {
	resolveUrl,
	createRangeHeader,
	createFetchHeaders,
} from '../../src/hls/hls-utils.js';

describe('resolveUrl', () => {
	test('resolves relative URL', () => {
		expect(resolveUrl('segment.ts', 'https://example.com/hls/playlist.m3u8'))
			.toBe('https://example.com/hls/segment.ts');
	});

	test('resolves URL with parent directory reference', () => {
		expect(resolveUrl('../segment.ts', 'https://example.com/hls/a/playlist.m3u8'))
			.toBe('https://example.com/hls/segment.ts');
	});

	test('resolves URL with subdirectory', () => {
		expect(resolveUrl('sub/segment.ts', 'https://example.com/hls/playlist.m3u8'))
			.toBe('https://example.com/hls/sub/segment.ts');
	});

	test('handles absolute URL', () => {
		expect(resolveUrl('https://cdn.example.com/segment.ts', 'https://example.com/playlist.m3u8'))
			.toBe('https://cdn.example.com/segment.ts');
	});

	test('handles root-relative URL', () => {
		expect(resolveUrl('/media/segment.ts', 'https://example.com/hls/playlist.m3u8'))
			.toBe('https://example.com/media/segment.ts');
	});
});

describe('createRangeHeader', () => {
	test('creates range header with explicit offset', () => {
		expect(createRangeHeader({ length: 100, offset: 50 }))
			.toBe('bytes=50-149');
	});

	test('creates range header with zero offset', () => {
		expect(createRangeHeader({ length: 100, offset: 0 }))
			.toBe('bytes=0-99');
	});

	test('defaults offset to 0 when not specified', () => {
		expect(createRangeHeader({ length: 100 }))
			.toBe('bytes=0-99');
	});

	test('handles single byte range', () => {
		expect(createRangeHeader({ length: 1, offset: 0 }))
			.toBe('bytes=0-0');
	});

	test('handles large offset and length', () => {
		expect(createRangeHeader({ length: 1000000, offset: 5000000 }))
			.toBe('bytes=5000000-5999999');
	});
});

describe('createFetchHeaders', () => {
	test('returns empty object when no byteRange provided', () => {
		expect(createFetchHeaders()).toEqual({});
	});

	test('returns empty object when byteRange is undefined', () => {
		expect(createFetchHeaders(undefined)).toEqual({});
	});

	test('includes Range header when byteRange is provided', () => {
		expect(createFetchHeaders({ length: 100, offset: 0 }))
			.toEqual({ Range: 'bytes=0-99' });
	});

	test('includes correct Range header with offset', () => {
		expect(createFetchHeaders({ length: 500, offset: 1000 }))
			.toEqual({ Range: 'bytes=1000-1499' });
	});
});
