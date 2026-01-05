/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Information about a media segment for segment-based fragment access.
 * @group HLS
 * @public
 */
export type FragmentSegmentInfo = {
	/** Unique identifier for this segment (typically mediaSequence for HLS). */
	segmentId: number;
	/** Start time of this segment in seconds (in cumulative HLS time, not fMP4 internal time). */
	startTime: number;
	/** Duration of this segment in seconds. */
	duration: number;
	/** Virtual byte offset of this segment in the stream. Only accurate after segment is fetched. */
	byteOffset?: number;
	/** Whether this segment has a discontinuity before it (timestamps may have reset). */
	hasDiscontinuity?: boolean;
};

/**
 * Interface for sources that provide fragmented media with segment-based access.
 * This is used for HLS live streams where byte offsets are not stable due to
 * sliding window behavior.
 *
 * Instead of byte offsets, this interface uses segment identifiers (mediaSequence)
 * and time-based lookups for fragment access.
 *
 * @group HLS
 * @public
 */
export interface FragmentedMediaSource {
	/**
	 * Whether this is a live stream (no definite end).
	 * For live streams, segment-based lookup is used instead of byte offsets.
	 */
	readonly isLive: boolean;

	/**
	 * Returns the available time range in seconds [start, end].
	 * For VOD, this is typically [0, totalDuration].
	 * For live streams, this changes as the sliding window moves.
	 */
	getAvailableTimeRange(): { start: number; end: number };

	/**
	 * Finds the segment containing the given timestamp.
	 * @param timeInSeconds - The timestamp to search for.
	 * @returns The segment info, or null if no segment contains this time.
	 */
	findSegmentAtTime(timeInSeconds: number): FragmentSegmentInfo | null;

	/**
	 * Reads raw segment data by segment ID.
	 * @param segmentId - The segment identifier (mediaSequence for HLS).
	 * @returns The segment data as Uint8Array.
	 */
	readSegmentData(segmentId: number): Promise<Uint8Array>;

	/**
	 * Returns all currently available segments.
	 * For live streams, this list changes as the sliding window moves.
	 */
	getAvailableSegments(): FragmentSegmentInfo[];

	/**
	 * Gets the byte offset for a specific segment ID.
	 * More efficient than getAvailableSegments() when you only need one segment.
	 * @param segmentId - The segment identifier (mediaSequence for HLS).
	 * @returns The byte offset, or undefined if not available (segment not fetched yet).
	 */
	getSegmentByteOffset?(segmentId: number): number | undefined;

	/**
	 * Gets the expected start time for a segment in cumulative HLS time.
	 * This is used to adjust timestamps for segments after discontinuities.
	 * @param segmentId - The segment identifier (mediaSequence for HLS).
	 * @returns The expected start time in seconds, or undefined if segment not found.
	 */
	getSegmentExpectedStartTime?(segmentId: number): number | undefined;
}
