/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { parseMediaPlaylist, parsePlaylist } from './m3u8-parser';
import type { ByteRange, MasterPlaylist, MediaPlaylist, VariantStream, MediaRendition } from './m3u8-types';

/**
 * Quality selection by bandwidth.
 * @group Input sources
 * @public
 */
export type HlsQualitySelectionByBandwidth = {
	/** Target bandwidth in bits per second. */
	bandwidth: number;
};

/**
 * Quality selection by resolution.
 * @group Input sources
 * @public
 */
export type HlsQualitySelectionByResolution = {
	/** Target resolution. */
	resolution: {
		/** Width in pixels. */
		width: number;
		/** Height in pixels. */
		height: number;
	};
};

/**
 * Quality selection strategy for HLS variant selection.
 * @group Input sources
 * @public
 */
export type HlsQualitySelection =
	| 'highest'
	| 'lowest'
	| 'auto'
	| HlsQualitySelectionByBandwidth
	| HlsQualitySelectionByResolution;

/**
 * Options for {@link HlsSource}.
 * @group Input sources
 * @public
 */
export type HlsSourceOptions = {
	/**
	 * Quality selection strategy when the manifest is a master playlist.
	 * - 'highest': Select the variant with the highest bandwidth
	 * - 'lowest': Select the variant with the lowest bandwidth
	 * - 'auto': Select based on network conditions (defaults to highest for now)
	 * - `\{ bandwidth: number \}`: Select the variant closest to the specified bandwidth
	 * - `\{ resolution: \{ width, height \} \}`: Select the variant closest to the specified resolution
	 *
	 * Defaults to 'auto'.
	 */
	qualitySelection?: HlsQualitySelection;

	/**
	 * Options to pass to the fetch request.
	 */
	requestInit?: RequestInit;

	/**
	 * Custom fetch function.
	 */
	fetchFn?: typeof fetch;

	/**
	 * Optional retry delay function. Returns the delay in milliseconds before retrying,
	 * or null to stop retrying.
	 */
	getRetryDelay?: (previousAttempts: number, error: unknown, url: string) => number | null;
};

/**
 * Represents a resolved HLS stream with its manifest and selected variant.
 * @group Input sources
 * @public
 */
export type HlsResolvedStream = {
	/** The base URL for resolving relative segment URIs. */
	baseUrl: string;
	/** The media playlist for this stream. */
	mediaPlaylist: MediaPlaylist;
	/** The original master playlist, if this came from a master playlist. */
	masterPlaylist?: MasterPlaylist;
	/** The selected variant stream, if this came from a master playlist. */
	selectedVariant?: VariantStream;
	/** Audio renditions available for this stream. */
	audioRenditions?: MediaRendition[];
	/** Subtitle renditions available for this stream. */
	subtitleRenditions?: MediaRendition[];
	/** Whether this is a live stream (no #EXT-X-ENDLIST). */
	isLive: boolean;
};

/**
 * HLS source for reading HLS (HTTP Live Streaming) content.
 * This class handles manifest parsing and variant selection.
 * @group Input sources
 * @public
 */
export class HlsSource {
	/** @internal */
	private manifestUrl: string;
	/** @internal */
	private options: Required<Omit<HlsSourceOptions, 'requestInit' | 'fetchFn' | 'getRetryDelay'>> & HlsSourceOptions;
	/** @internal */
	private resolvedStream: HlsResolvedStream | null = null;
	/** @internal */
	private disposed = false;

	/**
	 * Creates a new {@link HlsSource} for the specified manifest URL.
	 * @param manifestUrl - URL to the HLS manifest (.m3u8 file)
	 * @param options - Configuration options
	 */
	constructor(manifestUrl: string, options: HlsSourceOptions = {}) {
		if (typeof manifestUrl !== 'string') {
			throw new TypeError('manifestUrl must be a string.');
		}
		if (!options || typeof options !== 'object') {
			throw new TypeError('options must be an object.');
		}

		this.manifestUrl = manifestUrl;
		this.options = {
			qualitySelection: options.qualitySelection ?? 'auto',
			...options,
		};
	}

	/**
	 * Resolves the HLS stream by fetching and parsing the manifest.
	 * If the manifest is a master playlist, selects an appropriate variant based on options.
	 */
	async resolve(): Promise<HlsResolvedStream> {
		if (this.disposed) {
			throw new Error('HlsSource has been disposed.');
		}

		if (this.resolvedStream) {
			return this.resolvedStream;
		}

		const content = await this.fetchManifest(this.manifestUrl);
		const playlist = parsePlaylist(content);

		if (playlist.type === 'master') {
			this.resolvedStream = await this.resolveMasterPlaylist(playlist, this.manifestUrl);
		} else {
			this.resolvedStream = {
				baseUrl: this.getBaseUrl(this.manifestUrl),
				mediaPlaylist: playlist,
				isLive: !playlist.endList,
			};
		}

		return this.resolvedStream;
	}

	/**
	 * Refreshes the playlist for live streams.
	 * This fetches the latest version of the media playlist and updates the resolved stream.
	 * Only applicable for live streams (streams without #EXT-X-ENDLIST).
	 *
	 * @returns The updated resolved stream with new segments.
	 * @throws If the source has been disposed or hasn't been resolved yet.
	 */
	async refreshPlaylist(): Promise<HlsResolvedStream> {
		if (this.disposed) {
			throw new Error('HlsSource has been disposed.');
		}

		if (!this.resolvedStream) {
			throw new Error('HlsSource has not been resolved yet. Call resolve() first.');
		}

		if (!this.resolvedStream.isLive) {
			// VOD streams don't need refreshing
			return this.resolvedStream;
		}

		// Determine which playlist URL to fetch
		const playlistUrl = this.resolvedStream.selectedVariant
			? this.resolveUrl(this.resolvedStream.selectedVariant.uri, this.getBaseUrl(this.manifestUrl))
			: this.manifestUrl;

		const content = await this.fetchManifest(playlistUrl);
		const playlist = parseMediaPlaylist(content);

		// Update the resolved stream with the new playlist
		this.resolvedStream = {
			...this.resolvedStream,
			mediaPlaylist: playlist,
			isLive: !playlist.endList,
		};

		return this.resolvedStream;
	}

	/**
	 * Returns whether the stream is live (no #EXT-X-ENDLIST).
	 * Returns null if the stream hasn't been resolved yet.
	 */
	isLive(): boolean | null {
		if (!this.resolvedStream) {
			return null;
		}
		return this.resolvedStream.isLive;
	}

	/**
	 * Gets the resolved stream, or null if not yet resolved.
	 */
	getResolvedStream(): HlsResolvedStream | null {
		return this.resolvedStream;
	}

	/**
	 * Fetches the content of a segment.
	 * @param segmentUri - The URI of the segment (can be relative or absolute)
	 * @param byteRange - Optional byte range to fetch
	 */
	async fetchSegment(segmentUri: string, byteRange?: ByteRange): Promise<Uint8Array> {
		if (this.disposed) {
			throw new Error('HlsSource has been disposed.');
		}

		const resolvedStream = await this.resolve();
		const url = this.resolveUrl(segmentUri, resolvedStream.baseUrl);

		// Add Range header if byte range is specified
		let requestInit = this.options.requestInit;
		if (byteRange) {
			const start = byteRange.offset ?? 0;
			const end = start + byteRange.length - 1;
			requestInit = {
				...requestInit,
				headers: {
					...requestInit?.headers,
					Range: `bytes=${start}-${end}`,
				},
			};
		}

		const response = await this.doFetch(url, requestInit);

		if (!response.ok && response.status !== 206) {
			throw new Error(`Failed to fetch segment: ${response.status} ${response.statusText}`);
		}

		const buffer = await response.arrayBuffer();
		return new Uint8Array(buffer);
	}

	/**
	 * Fetches the initialization segment if available.
	 */
	async fetchInitSegment(): Promise<Uint8Array | null> {
		if (this.disposed) {
			throw new Error('HlsSource has been disposed.');
		}

		const resolvedStream = await this.resolve();
		const firstSegment = resolvedStream.mediaPlaylist.segments[0];

		if (!firstSegment?.map) {
			return null;
		}

		return this.fetchSegment(firstSegment.map.uri, firstSegment.map.byteRange);
	}

	/** @internal */
	private audioRenditionBaseUrl: string | null = null;

	/**
	 * Fetches and parses an audio rendition's media playlist.
	 * @param rendition - The audio rendition to fetch
	 * @returns The media playlist for the audio rendition, or null if no URI
	 */
	async fetchAudioRenditionPlaylist(rendition: MediaRendition): Promise<MediaPlaylist | null> {
		if (this.disposed) {
			throw new Error('HlsSource has been disposed.');
		}

		if (!rendition.uri) {
			return null;
		}

		const resolvedStream = await this.resolve();
		const masterBaseUrl = resolvedStream.masterPlaylist
			? this.getBaseUrl(this.manifestUrl)
			: resolvedStream.baseUrl;

		const playlistUrl = this.resolveUrl(rendition.uri, masterBaseUrl);
		// Store the base URL for audio rendition segments
		this.audioRenditionBaseUrl = this.getBaseUrl(playlistUrl);

		const content = await this.fetchManifest(playlistUrl);
		return parseMediaPlaylist(content);
	}

	/**
	 * Fetches the initialization segment for an audio rendition.
	 * @param renditionPlaylist - The media playlist for the audio rendition
	 */
	async fetchAudioRenditionInitSegment(renditionPlaylist: MediaPlaylist): Promise<Uint8Array | null> {
		if (this.disposed) {
			throw new Error('HlsSource has been disposed.');
		}

		const firstSegment = renditionPlaylist.segments[0];
		if (!firstSegment?.map) {
			return null;
		}

		if (!this.audioRenditionBaseUrl) {
			throw new Error('Audio rendition playlist must be fetched first.');
		}

		const url = this.resolveUrl(firstSegment.map.uri, this.audioRenditionBaseUrl);
		return this.fetchUrlWithByteRange(url, firstSegment.map.byteRange);
	}

	/**
	 * Fetches a segment from an audio rendition playlist.
	 * @param segmentUri - The URI of the segment
	 * @param byteRange - Optional byte range
	 */
	async fetchAudioRenditionSegment(segmentUri: string, byteRange?: ByteRange): Promise<Uint8Array> {
		if (this.disposed) {
			throw new Error('HlsSource has been disposed.');
		}

		if (!this.audioRenditionBaseUrl) {
			throw new Error('Audio rendition playlist must be fetched first.');
		}

		const url = this.resolveUrl(segmentUri, this.audioRenditionBaseUrl);
		return this.fetchUrlWithByteRange(url, byteRange);
	}

	/**
	 * Gets the default audio rendition for the selected variant.
	 */
	getDefaultAudioRendition(): MediaRendition | null {
		const resolvedStream = this.resolvedStream;
		if (!resolvedStream?.audioRenditions || !resolvedStream.selectedVariant?.audio) {
			return null;
		}

		const audioGroupId = resolvedStream.selectedVariant.audio;
		const matchingRenditions = resolvedStream.audioRenditions.filter(
			r => r.groupId === audioGroupId,
		);

		// Prefer default rendition, then first one
		return matchingRenditions.find(r => r.default) ?? matchingRenditions[0] ?? null;
	}

	/**
	 * Disposes of this source, releasing any resources.
	 */
	dispose(): void {
		this.disposed = true;
		this.resolvedStream = null;
	}

	/**
	 * Returns whether this source has been disposed.
	 */
	isDisposed(): boolean {
		return this.disposed;
	}

	/** @internal */
	private async fetchManifest(url: string): Promise<string> {
		const response = await this.doFetch(url);

		if (!response.ok) {
			throw new Error(`Failed to fetch manifest: ${response.status} ${response.statusText}`);
		}

		return response.text();
	}

	/** @internal */
	private async doFetch(url: string, requestInit?: RequestInit): Promise<Response> {
		const fetchFn = this.options.fetchFn ?? fetch;
		const finalRequestInit = requestInit ?? this.options.requestInit;
		const getRetryDelay = this.options.getRetryDelay;

		let attempts = 0;

		while (true) {
			try {
				return await fetchFn(url, finalRequestInit);
			} catch (error) {
				if (!getRetryDelay) {
					throw error;
				}

				const delay = getRetryDelay(attempts, error, url);
				if (delay === null) {
					throw error;
				}

				await new Promise(resolve => setTimeout(resolve, delay));
				attempts++;
			}
		}
	}

	/** @internal */
	private async resolveMasterPlaylist(
		masterPlaylist: MasterPlaylist,
		masterUrl: string,
	): Promise<HlsResolvedStream> {
		const selectedVariant = this.selectVariant(masterPlaylist.variants);

		if (!selectedVariant) {
			throw new Error('No suitable variant found in master playlist.');
		}

		const baseUrl = this.getBaseUrl(masterUrl);
		const mediaPlaylistUrl = this.resolveUrl(selectedVariant.uri, baseUrl);
		const mediaPlaylistContent = await this.fetchManifest(mediaPlaylistUrl);
		const mediaPlaylist = parseMediaPlaylist(mediaPlaylistContent);

		// Collect renditions
		const audioRenditions = masterPlaylist.media.filter(m => m.type === 'AUDIO');
		const subtitleRenditions = masterPlaylist.media.filter(m => m.type === 'SUBTITLES');

		return {
			baseUrl: this.getBaseUrl(mediaPlaylistUrl),
			mediaPlaylist,
			masterPlaylist,
			selectedVariant,
			audioRenditions: audioRenditions.length > 0 ? audioRenditions : undefined,
			subtitleRenditions: subtitleRenditions.length > 0 ? subtitleRenditions : undefined,
			isLive: !mediaPlaylist.endList,
		};
	}

	/** @internal */
	private selectVariant(variants: VariantStream[]): VariantStream | null {
		if (variants.length === 0) {
			return null;
		}

		// Filter to prefer variants with widely-supported codecs (AAC audio, not Dolby)
		const preferredVariants = variants.filter((v) => {
			if (!v.codecs) return true;
			// Exclude Dolby codecs (ec-3, ac-3) as they're not widely supported
			return !v.codecs.includes('ec-3') && !v.codecs.includes('ac-3');
		});

		// Use preferred variants if available, otherwise fall back to all variants
		const candidateVariants = preferredVariants.length > 0 ? preferredVariants : variants;

		const selection = this.options.qualitySelection;

		if (selection === 'highest' || selection === 'auto') {
			// Sort by bandwidth descending and pick the first
			return [...candidateVariants].sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? null;
		}

		if (selection === 'lowest') {
			// Sort by bandwidth ascending and pick the first
			return [...candidateVariants].sort((a, b) => a.bandwidth - b.bandwidth)[0] ?? null;
		}

		if ('bandwidth' in selection) {
			// Find the variant with bandwidth closest to the specified value
			return this.findClosestVariantByBandwidth(variants, selection.bandwidth);
		}

		if ('resolution' in selection) {
			// Find the variant with resolution closest to the specified value
			return this.findClosestVariantByResolution(variants, selection.resolution);
		}

		// Default to highest
		return [...variants].sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? null;
	}

	/** @internal */
	private findClosestVariantByBandwidth(
		variants: VariantStream[],
		targetBandwidth: number,
	): VariantStream | null {
		let closest: VariantStream | null = null;
		let minDiff = Infinity;

		for (const variant of variants) {
			const diff = Math.abs(variant.bandwidth - targetBandwidth);
			if (diff < minDiff) {
				minDiff = diff;
				closest = variant;
			}
		}

		return closest;
	}

	/** @internal */
	private findClosestVariantByResolution(
		variants: VariantStream[],
		targetResolution: { width: number; height: number },
	): VariantStream | null {
		let closest: VariantStream | null = null;
		let minDiff = Infinity;

		for (const variant of variants) {
			if (!variant.resolution) continue;

			const diff = Math.abs(variant.resolution.width - targetResolution.width)
				+ Math.abs(variant.resolution.height - targetResolution.height);

			if (diff < minDiff) {
				minDiff = diff;
				closest = variant;
			}
		}

		// If no variant has resolution info, fall back to bandwidth-based selection
		if (!closest) {
			return [...variants].sort((a, b) => b.bandwidth - a.bandwidth)[0] ?? null;
		}

		return closest;
	}

	/** @internal */
	private getBaseUrl(url: string): string {
		const lastSlash = url.lastIndexOf('/');
		return lastSlash >= 0 ? url.substring(0, lastSlash + 1) : '';
	}

	/** @internal */
	private resolveUrl(relativeOrAbsolute: string, baseUrl: string): string {
		// Check if it's already an absolute URL
		if (relativeOrAbsolute.startsWith('http://') || relativeOrAbsolute.startsWith('https://')) {
			return relativeOrAbsolute;
		}

		// Handle absolute paths
		if (relativeOrAbsolute.startsWith('/')) {
			const urlObj = new URL(baseUrl);
			return `${urlObj.origin}${relativeOrAbsolute}`;
		}

		// Relative path
		return baseUrl + relativeOrAbsolute;
	}

	/** @internal */
	private async fetchUrlWithByteRange(url: string, byteRange?: ByteRange): Promise<Uint8Array> {
		let requestInit = this.options.requestInit;
		if (byteRange) {
			const start = byteRange.offset ?? 0;
			const end = start + byteRange.length - 1;
			requestInit = {
				...requestInit,
				headers: {
					...requestInit?.headers,
					Range: `bytes=${start}-${end}`,
				},
			};
		}

		const response = await this.doFetch(url, requestInit);

		if (!response.ok && response.status !== 206) {
			throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
		}

		const buffer = await response.arrayBuffer();
		return new Uint8Array(buffer);
	}
}
