/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Input } from '../input';
import { InputAudioTrack, InputVideoTrack } from '../input-track';
import { polyfillSymbolDispose } from '../misc';
import { resolveUrl } from './hls-utils';
import { HlsVariantInput } from './hls-variant-input';
import { parsePlaylist } from './m3u8-parser';
import type { MasterPlaylist, MediaPlaylist, VariantStream } from './m3u8-types';

polyfillSymbolDispose();

/**
 * Represents an HLS variant stream with its metadata.
 * @group HLS
 * @public
 */
export type HlsVariant = {
	/** Bandwidth in bits per second. */
	bandwidth: number;
	/** Average bandwidth in bits per second. */
	averageBandwidth?: number;
	/** Video resolution. */
	resolution?: {
		/** Width in pixels. */
		width: number;
		/** Height in pixels. */
		height: number;
	};
	/** Codec string (e.g., "avc1.64001f,mp4a.40.2"). */
	codecs?: string;
	/** Frame rate. */
	frameRate?: number;
	/** The URI of the variant's media playlist. */
	uri: string;
};

/**
 * Options for creating an HlsInput.
 * @group HLS
 * @public
 */
export type HlsInputOptions = {
	/**
	 * Custom fetch function for network requests.
	 * Useful for adding authentication headers or custom request handling.
	 */
	fetch?: typeof fetch;
};

/**
 * Represents an HLS stream as a "super input" that can contain multiple variants (quality levels).
 *
 * This class provides a unified interface for working with HLS streams, allowing you to:
 * - List available variants (quality levels)
 * - Select a specific variant
 * - Access tracks from the selected variant using the familiar Input API
 *
 * @example
 * ```typescript
 * // Simple usage - automatically selects highest quality
 * const hlsInput = new HlsInput('https://example.com/master.m3u8');
 * const videoTrack = await hlsInput.getPrimaryVideoTrack();
 *
 * // List available variants
 * const variants = await hlsInput.getVariants();
 * console.log(variants.map(v => v.resolution));
 *
 * // Select a specific variant
 * const variant720p = variants.find(v => v.resolution?.height === 720);
 * if (variant720p) {
 *   await hlsInput.selectVariant(variant720p);
 * }
 * ```
 *
 * @group HLS
 * @public
 */
export class HlsInput implements Disposable {
	/** @internal */
	private manifestUrl: string;
	/** @internal */
	private options: Required<HlsInputOptions>;
	/** @internal */
	private _masterPlaylist: MasterPlaylist | null = null;
	/** @internal */
	private mediaPlaylist: MediaPlaylist | null = null;
	/** @internal */
	private _currentMediaPlaylist: MediaPlaylist | null = null;
	/** @internal */
	private variants: HlsVariant[] = [];
	/** @internal */
	private selectedVariant: HlsVariant | null = null;
	/** @internal */
	private selectedInput: HlsVariantInput | null = null;
	/** @internal */
	private selectedAudioInput: HlsVariantInput | null = null;
	/** @internal */
	private initPromise: Promise<void> | null = null;
	/** @internal */
	private _disposed = false;

	/**
	 * Creates a new HlsInput from the specified manifest URL.
	 * @param manifestUrl - The URL of the HLS manifest (.m3u8 file).
	 * @param options - Configuration options.
	 */
	constructor(manifestUrl: string, options: HlsInputOptions = {}) {
		if (typeof manifestUrl !== 'string' || !manifestUrl) {
			throw new TypeError('manifestUrl must be a non-empty string.');
		}

		this.manifestUrl = manifestUrl;
		this.options = {
			fetch: options.fetch ?? fetch.bind(globalThis),
		};
	}

	/** True if the input has been disposed. */
	get disposed() {
		return this._disposed;
	}

	/** @internal */
	private async initialize(): Promise<void> {
		if (this.initPromise) return this.initPromise;

		this.initPromise = (async () => {
			const response = await this.options.fetch(this.manifestUrl);
			if (!response.ok) {
				throw new Error(`Failed to fetch HLS manifest: ${response.status} ${response.statusText}`);
			}

			const text = await response.text();
			const playlist = parsePlaylist(text);

			if (playlist.type === 'master') {
				this._masterPlaylist = playlist;
				this.variants = playlist.variants.map(v => this.variantStreamToHlsVariant(v));

				// Auto-select highest bandwidth variant
				if (this.variants.length > 0) {
					const sorted = [...this.variants].sort((a, b) => b.bandwidth - a.bandwidth);
					this.selectedVariant = sorted[0]!;
				}
			} else {
				// Single media playlist (no variants)
				this.mediaPlaylist = playlist;
				this.variants = [];
				this.selectedVariant = null;
			}
		})();

		return this.initPromise;
	}

	/** @internal */
	private variantStreamToHlsVariant(v: VariantStream): HlsVariant {
		return {
			bandwidth: v.bandwidth,
			averageBandwidth: v.averageBandwidth,
			resolution: v.resolution,
			codecs: v.codecs,
			frameRate: v.frameRate,
			uri: v.uri,
		};
	}

	/**
	 * Returns the list of available variants (quality levels).
	 * For a single media playlist (no master), returns an empty array.
	 */
	async getVariants(): Promise<HlsVariant[]> {
		await this.initialize();
		return [...this.variants];
	}

	/**
	 * Returns the currently selected variant, or null if this is a single media playlist.
	 */
	async getSelectedVariant(): Promise<HlsVariant | null> {
		await this.initialize();
		return this.selectedVariant;
	}

	/**
	 * Selects a variant (quality level) to use.
	 * This disposes any previously selected variant's input.
	 * @param variant - The variant to select (must be from getVariants()).
	 */
	async selectVariant(variant: HlsVariant): Promise<void> {
		await this.initialize();

		if (!this.variants.some(v => v.uri === variant.uri)) {
			throw new Error('Invalid variant: must be a variant from getVariants().');
		}

		// Dispose previous inputs if different variant
		if (this.selectedInput && this.selectedVariant?.uri !== variant.uri) {
			this.selectedInput.dispose();
			this.selectedInput = null;
			this.selectedAudioInput?.dispose();
			this.selectedAudioInput = null;
		}

		this.selectedVariant = variant;
	}

	/**
	 * Returns an Input for the currently selected variant (video).
	 * This Input can be used with the standard Mediabunny API.
	 * @internal
	 */
	private async getInput(): Promise<Input> {
		await this.initialize();

		if (this.selectedInput) {
			return this.selectedInput;
		}

		let mediaPlaylistUrl: string;
		let mediaPlaylist: MediaPlaylist;

		if (this.mediaPlaylist) {
			// Single media playlist
			mediaPlaylistUrl = this.manifestUrl;
			mediaPlaylist = this.mediaPlaylist;
		} else if (this.selectedVariant) {
			// Fetch variant's media playlist
			mediaPlaylistUrl = resolveUrl(this.selectedVariant.uri, this.manifestUrl);
			const response = await this.options.fetch(mediaPlaylistUrl);
			if (!response.ok) {
				throw new Error(`Failed to fetch media playlist: ${response.status}`);
			}
			const text = await response.text();
			const parsed = parsePlaylist(text);
			if (parsed.type !== 'media') {
				throw new Error('Expected media playlist but got master playlist.');
			}
			mediaPlaylist = parsed;

			// Also fetch separate audio playlist if variant has one
			await this.fetchSeparateAudioInput();
		} else {
			throw new Error('No variant selected and no media playlist available.');
		}

		// Store for duration calculation
		this._currentMediaPlaylist = mediaPlaylist;

		this.selectedInput = new HlsVariantInput(
			mediaPlaylist,
			mediaPlaylistUrl,
			this.options.fetch,
		);

		return this.selectedInput;
	}

	/**
	 * Fetches the separate audio input if the selected variant has one.
	 * @internal
	 */
	private async fetchSeparateAudioInput(): Promise<void> {
		if (!this._masterPlaylist || !this.selectedVariant) {
			return;
		}

		// Find the original variant stream to get the audio GROUP-ID
		const originalVariant = this._masterPlaylist.variants.find(
			v => v.uri === this.selectedVariant!.uri,
		);
		if (!originalVariant?.audio) {
			return;
		}

		// Find the audio rendition matching the variant's audio GROUP-ID
		const audioGroupId = originalVariant.audio;
		const audioRendition = this._masterPlaylist.media.find(
			m => m.type === 'AUDIO' && m.groupId === audioGroupId && m.uri,
		);

		if (!audioRendition?.uri) {
			// No separate audio playlist (audio might be muxed with video)
			return;
		}

		// Fetch audio media playlist
		const audioPlaylistUrl = resolveUrl(audioRendition.uri, this.manifestUrl);
		const response = await this.options.fetch(audioPlaylistUrl);
		if (!response.ok) {
			throw new Error(`Failed to fetch audio media playlist: ${response.status}`);
		}

		const text = await response.text();
		const parsed = parsePlaylist(text);
		if (parsed.type !== 'media') {
			throw new Error('Expected audio media playlist but got master playlist.');
		}

		this.selectedAudioInput = new HlsVariantInput(
			parsed,
			audioPlaylistUrl,
			this.options.fetch,
		);
	}

	/**
	 * Returns the audio input for separate audio renditions, or null if audio is muxed.
	 * @internal
	 */
	private async getAudioInput(): Promise<HlsVariantInput | null> {
		await this.getInput(); // Ensure video input is loaded (this also loads audio input)
		return this.selectedAudioInput;
	}

	/**
	 * Returns the list of all tracks from the selected variant.
	 * Includes tracks from separate audio renditions if available.
	 */
	async getTracks() {
		const input = await this.getInput();
		const audioInput = await this.getAudioInput();

		const tracks = [...await input.getTracks()];
		if (audioInput) {
			tracks.push(...await audioInput.getTracks());
		}
		return tracks;
	}

	/**
	 * Returns the list of all video tracks from the selected variant.
	 */
	async getVideoTracks(): Promise<InputVideoTrack[]> {
		const input = await this.getInput();
		return await input.getVideoTracks();
	}

	/**
	 * Gets audio tracks from both main input (muxed) and separate audio input.
	 * Returns muxed audio tracks if available, otherwise returns separate audio tracks.
	 * @internal
	 */
	private async getAudioTracksFromInputs(): Promise<InputAudioTrack[]> {
		const input = await this.getInput();
		const audioInput = await this.getAudioInput();

		// First check the main input (muxed audio)
		const audioTracks = await input.getAudioTracks();
		if (audioTracks.length > 0) {
			return audioTracks;
		}

		// If no muxed audio, check separate audio input
		if (audioInput) {
			return await audioInput.getAudioTracks();
		}

		return [];
	}

	/**
	 * Returns the list of all audio tracks from the selected variant.
	 * Includes tracks from separate audio renditions if available.
	 */
	async getAudioTracks(): Promise<InputAudioTrack[]> {
		return this.getAudioTracksFromInputs();
	}

	/**
	 * Returns the primary video track from the selected variant.
	 */
	async getPrimaryVideoTrack(): Promise<InputVideoTrack | null> {
		const input = await this.getInput();
		return await input.getPrimaryVideoTrack();
	}

	/**
	 * Returns the primary audio track from the selected variant.
	 * Checks both muxed audio and separate audio renditions.
	 */
	async getPrimaryAudioTrack(): Promise<InputAudioTrack | null> {
		const tracks = await this.getAudioTracksFromInputs();
		return tracks[0] ?? null;
	}

	/**
	 * Computes the duration of available content in seconds.
	 * For VOD streams, this is the total duration.
	 * For live streams, this returns the current total duration which grows as new segments are added.
	 */
	async computeDuration(): Promise<number> {
		// Ensure we have the media playlist loaded
		await this.getInput();

		// For live streams, get the live duration from the source
		// which updates as new segments are added
		if (this.selectedInput) {
			return await this.selectedInput.getLiveDuration();
		}

		const playlist = this._currentMediaPlaylist;
		if (!playlist) {
			return 0;
		}

		// Fallback: sum up all segment durations from the manifest
		return playlist.segments.reduce((sum, segment) => sum + segment.duration, 0);
	}

	/**
	 * Returns whether this is a live stream (no EXT-X-ENDLIST).
	 */
	async isLive(): Promise<boolean> {
		await this.getInput();
		return this._currentMediaPlaylist ? !this._currentMediaPlaylist.endList : false;
	}

	/**
	 * Returns the target duration in seconds (EXT-X-TARGETDURATION).
	 * This is the maximum duration of any segment in the playlist.
	 * For live streams, the HLS spec recommends starting playback at 3×targetDuration from the live edge.
	 */
	async getTargetDuration(): Promise<number> {
		await this.getInput();
		return this._currentMediaPlaylist?.targetDuration ?? 0;
	}

	/**
	 * Returns the MIME type of the selected variant.
	 */
	async getMimeType(): Promise<string> {
		const input = await this.getInput();
		return input.getMimeType();
	}

	/**
	 * Disposes this HLS input and frees all connected resources.
	 */
	dispose(): void {
		if (this._disposed) return;

		this._disposed = true;
		this.selectedInput?.dispose();
		this.selectedInput = null;
		this.selectedAudioInput?.dispose();
		this.selectedAudioInput = null;
	}

	/** @internal */
	[Symbol.dispose](): void {
		this.dispose();
	}
}
