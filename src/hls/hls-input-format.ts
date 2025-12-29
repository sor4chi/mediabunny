/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Demuxer } from '../demuxer';
import { Input } from '../input';
import { InputFormat } from '../input-format';
import { HlsDemuxer } from './hls-demuxer';

/**
 * HLS (HTTP Live Streaming) input format for fMP4-based HLS streams.
 *
 * This format works with {@link HlsVirtualSource} which presents HLS segments
 * as a virtual byte stream that can be demuxed by the underlying ISOBMFF demuxer.
 *
 * Do not instantiate this class; use the {@link HLS_INPUT} singleton instead.
 *
 * @group Input formats
 * @public
 */
export class HlsInputFormat extends InputFormat {
	/** @internal */
	async _canReadInput(input: Input): Promise<boolean> {
		// Check if the source is an HlsVirtualSource by checking for the marker
		const source = input._source as { _isHlsVirtualSource?: boolean };
		return source._isHlsVirtualSource === true;
	}

	/** @internal */
	_createDemuxer(input: Input): Demuxer {
		return new HlsDemuxer(input);
	}

	get name() {
		return 'HLS';
	}

	get mimeType() {
		return 'application/vnd.apple.mpegurl';
	}
}

/**
 * HLS input format singleton.
 * @group Input formats
 * @public
 */
export const HLS_INPUT = /* #__PURE__ */ new HlsInputFormat();
