/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Information about an HLS segment.
 * @group Miscellaneous
 * @public
 */
export type HlsSegmentInfo = {
	/** Segment number (0-indexed). */
	number: number;
	/** Start timestamp of the segment in seconds. */
	timestamp: number;
	/** Duration of the segment in seconds. */
	duration: number;
	/** File name of the segment. */
	fileName: string;
	/** Raw segment data. */
	data: Uint8Array;
};
