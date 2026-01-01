/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import type { ByteRange } from './m3u8-types';

/**
 * Resolves a URI relative to a base URL.
 * @internal
 */
export const resolveUrl = (uri: string, baseUrl: string): string => {
	return new URL(uri, baseUrl).href;
};

/**
 * Creates a Range header value from a ByteRange.
 * @internal
 */
export const createRangeHeader = (byteRange: ByteRange): string => {
	const start = byteRange.offset ?? 0;
	const end = start + byteRange.length - 1;
	return `bytes=${start}-${end}`;
};

/**
 * Creates headers object with optional Range header for byte range requests.
 * @internal
 */
export const createFetchHeaders = (byteRange?: ByteRange): HeadersInit => {
	const headers: HeadersInit = {};
	if (byteRange) {
		headers['Range'] = createRangeHeader(byteRange);
	}
	return headers;
};
