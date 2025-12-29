/*!
 * Copyright (c) 2025-present, Vanilagy and contributors
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Target } from '../target';
import { NullTargetWriter, Writer } from '../writer';
import type { HlsSegmentInfo } from './hls-types';
import * as nodeAlias from '../node';

const node = typeof nodeAlias !== 'undefined'
	? nodeAlias
	: undefined!;

/**
 * Abstract base class for HLS output targets.
 * @group Output targets
 * @public
 */
export abstract class HlsTarget extends Target {
	/** @internal */
	_createWriter(): Writer {
		// HLS doesn't use a traditional writer; data is written via callbacks
		// Cast is safe because we never actually use the writer - HLS uses segment callbacks instead
		return new NullTargetWriter(this as unknown as import('../target').NullTarget);
	}

	/**
	 * Called when the initialization segment is ready.
	 * @internal
	 */
	abstract _writeInitSegment(fileName: string, data: Uint8Array): void;

	/**
	 * Called when a media segment is ready.
	 * @internal
	 */
	abstract _writeSegment(segment: HlsSegmentInfo): void;

	/**
	 * Called when a segment should be removed (for live streams with sliding window).
	 * @internal
	 */
	abstract _removeSegment(fileName: string): void;

	/**
	 * Called when the playlist is updated.
	 * @internal
	 */
	abstract _writePlaylist(fileName: string, content: string): void;

	/**
	 * Called when the HLS output is finalized.
	 * @internal
	 */
	abstract _finalize(): void;
}

/**
 * HLS target that stores all files in memory.
 * @group Output targets
 * @public
 */
export class HlsBufferTarget extends HlsTarget {
	/** Map of file names to their content. */
	files = new Map<string, Uint8Array | string>();

	/** @internal */
	_writeInitSegment(fileName: string, data: Uint8Array): void {
		this.files.set(fileName, data);
	}

	/** @internal */
	_writeSegment(segment: HlsSegmentInfo): void {
		this.files.set(segment.fileName, segment.data);
	}

	/** @internal */
	_removeSegment(fileName: string): void {
		this.files.delete(fileName);
	}

	/** @internal */
	_writePlaylist(fileName: string, content: string): void {
		this.files.set(fileName, content);
	}

	/** @internal */
	_finalize(): void {
		// Nothing to do for buffer target
	}

	/**
	 * Gets a file by name.
	 * @param fileName - The name of the file to get.
	 * @returns The file content, or undefined if not found.
	 */
	getFile(fileName: string): Uint8Array | string | undefined {
		return this.files.get(fileName);
	}

	/**
	 * Gets all file names.
	 * @returns An array of all file names.
	 */
	getFileNames(): string[] {
		return [...this.files.keys()];
	}
}

/**
 * Options for {@link HlsCallbackTarget}.
 * @group Output targets
 * @public
 */
export type HlsCallbackTargetOptions = {
	/**
	 * Called when the initialization segment is ready.
	 */
	onInitSegment?: (fileName: string, data: Uint8Array) => void | Promise<void>;

	/**
	 * Called when a media segment is ready.
	 */
	onSegment?: (segment: HlsSegmentInfo) => void | Promise<void>;

	/**
	 * Called when a segment should be removed (for live streams).
	 */
	onSegmentRemove?: (fileName: string) => void | Promise<void>;

	/**
	 * Called when the playlist is updated.
	 */
	onPlaylist?: (fileName: string, content: string) => void | Promise<void>;

	/**
	 * Called when the HLS output is finalized.
	 */
	onFinalize?: () => void | Promise<void>;
};

/**
 * HLS target that calls user-provided callbacks for each event.
 * Useful for custom streaming implementations.
 * @group Output targets
 * @public
 */
export class HlsCallbackTarget extends HlsTarget {
	/** @internal */
	private options: HlsCallbackTargetOptions;

	/** Creates a new {@link HlsCallbackTarget} with the specified callbacks. */
	constructor(options: HlsCallbackTargetOptions = {}) {
		super();
		this.options = options;
	}

	/** @internal */
	_writeInitSegment(fileName: string, data: Uint8Array): void {
		void this.options.onInitSegment?.(fileName, data);
	}

	/** @internal */
	_writeSegment(segment: HlsSegmentInfo): void {
		void this.options.onSegment?.(segment);
	}

	/** @internal */
	_removeSegment(fileName: string): void {
		void this.options.onSegmentRemove?.(fileName);
	}

	/** @internal */
	_writePlaylist(fileName: string, content: string): void {
		void this.options.onPlaylist?.(fileName, content);
	}

	/** @internal */
	_finalize(): void {
		void this.options.onFinalize?.();
	}
}

/**
 * Options for {@link HlsFileSystemTarget}.
 * @group Output targets
 * @public
 */
export type HlsFileSystemTargetOptions = {
	/**
	 * Whether to delete old segment files when they're removed from the playlist.
	 * Defaults to true.
	 */
	deleteOldSegments?: boolean;
};

/**
 * HLS target that writes files to the file system.
 * Intended for server-side usage in Node, Bun, or Deno.
 * @group Output targets
 * @public
 */
export class HlsFileSystemTarget extends HlsTarget {
	/** @internal */
	private directory: string;
	/** @internal */
	private options: HlsFileSystemTargetOptions;

	/** Creates a new {@link HlsFileSystemTarget} that writes to the specified directory. */
	constructor(directory: string, options: HlsFileSystemTargetOptions = {}) {
		if (typeof directory !== 'string') {
			throw new TypeError('directory must be a string.');
		}

		super();
		this.directory = directory;
		this.options = {
			deleteOldSegments: options.deleteOldSegments ?? true,
		};
	}

	/** @internal */
	private getFilePath(fileName: string): string {
		// Simple path join - could use path.join but keeping it simple
		const sep = this.directory.includes('\\') ? '\\' : '/';
		return this.directory.replace(/[/\\]$/, '') + sep + fileName;
	}

	/** @internal */
	_writeInitSegment(fileName: string, data: Uint8Array): void {
		const filePath = this.getFilePath(fileName);
		node.fs.mkdir(this.directory, { recursive: true })
			.then(() => node.fs.writeFile(filePath, data))
			.catch((err: Error) => {
				console.error(`Failed to write init segment: ${err.message}`);
			});
	}

	/** @internal */
	_writeSegment(segment: HlsSegmentInfo): void {
		const filePath = this.getFilePath(segment.fileName);
		node.fs.writeFile(filePath, segment.data)
			.catch((err: Error) => {
				console.error(`Failed to write segment: ${err.message}`);
			});
	}

	/** @internal */
	_removeSegment(fileName: string): void {
		if (!this.options.deleteOldSegments) return;

		const filePath = this.getFilePath(fileName);
		node.fs.unlink(filePath)
			.catch(() => {
				// Ignore errors - file might not exist
			});
	}

	/** @internal */
	_writePlaylist(fileName: string, content: string): void {
		const filePath = this.getFilePath(fileName);
		node.fs.writeFile(filePath, content, 'utf-8')
			.catch((err: Error) => {
				console.error(`Failed to write playlist: ${err.message}`);
			});
	}

	/** @internal */
	_finalize(): void {
		// Nothing special to do
	}
}
