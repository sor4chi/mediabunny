import { describe, it, expect } from 'vitest';
import { EncodedPacket } from '../../src/packet.js';

describe('HLS fMP4 Demuxer Fixes', () => {
	describe('Timestamp remapping', () => {
		it('should clone packet with adjusted timestamp', () => {
			// fMP4 internal timestamp: 10.0s (from baseMediaDecodeTime)
			// HLS playlist start time: 0.0s
			const originalPacket = new EncodedPacket(
				new Uint8Array([1, 2, 3, 4]),
				'key',
				10.0,
				0.033,
				721,
			);

			const playlistStartTime = 0.0;
			const timestampOffset = originalPacket.timestamp - playlistStartTime;
			const adjustedPacket = originalPacket.clone({
				timestamp: originalPacket.timestamp - timestampOffset,
			});

			expect(adjustedPacket.timestamp).toBe(0.0);
			expect(adjustedPacket.type).toBe('key');
			expect(adjustedPacket.duration).toBe(0.033);
			expect(adjustedPacket.sequenceNumber).toBe(721);
			expect(adjustedPacket.data).toBe(originalPacket.data);
		});

		it('should preserve relative timing within segment', () => {
			const playlistStartTime = 6.0;
			const fmp4BaseTime = 10.0;
			const timestampOffset = fmp4BaseTime - playlistStartTime;

			const packets = [
				new EncodedPacket(new Uint8Array([1]), 'key', 10.0, 0.033, 100),
				new EncodedPacket(new Uint8Array([2]), 'delta', 10.033, 0.033, 101),
				new EncodedPacket(new Uint8Array([3]), 'delta', 10.066, 0.033, 102),
			];

			const adjustedPackets = packets.map(p =>
				p.clone({ timestamp: p.timestamp - timestampOffset }),
			);

			expect(adjustedPackets[0]!.timestamp).toBeCloseTo(6.0, 5);
			expect(adjustedPackets[1]!.timestamp).toBeCloseTo(6.033, 5);
			expect(adjustedPackets[2]!.timestamp).toBeCloseTo(6.066, 5);

			const relativeTiming1 = adjustedPackets[1]!.timestamp - adjustedPackets[0]!.timestamp;
			const relativeTiming2 = adjustedPackets[2]!.timestamp - adjustedPackets[1]!.timestamp;
			expect(relativeTiming1).toBeCloseTo(0.033, 5);
			expect(relativeTiming2).toBeCloseTo(0.033, 5);
		});
	});

	describe('DTS-based sorting', () => {
		it('should sort packets by sequenceNumber (DTS order), not timestamp (PTS)', () => {
			// B-frames have earlier PTS than reference P-frames,
			// but must be decoded AFTER them (higher sequenceNumber).
			// Decode order (DTS): I0 -> P3 -> B1 -> B2
			// Display order (PTS): I0 -> B1 -> B2 -> P3
			const packets = [
				new EncodedPacket(new Uint8Array([1]), 'key', 0.0, 0.033, 0),
				new EncodedPacket(new Uint8Array([2]), 'delta', 0.1, 0.033, 1),
				new EncodedPacket(new Uint8Array([3]), 'delta', 0.033, 0.033, 2),
				new EncodedPacket(new Uint8Array([4]), 'delta', 0.066, 0.033, 3),
			];

			// Wrong: PTS sort puts B-frames before P-frame
			const ptsSorted = [...packets].sort((a, b) => a.timestamp - b.timestamp);
			expect(ptsSorted.map(p => p.sequenceNumber)).toEqual([0, 2, 3, 1]);

			// Correct: DTS sort maintains decode order
			const dtsSorted = [...packets].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
			expect(dtsSorted.map(p => p.sequenceNumber)).toEqual([0, 1, 2, 3]);

			expect(dtsSorted[0]!.type).toBe('key');
			expect(dtsSorted[1]!.sequenceNumber).toBe(1);
			expect(dtsSorted[2]!.sequenceNumber).toBe(2);
			expect(dtsSorted[3]!.sequenceNumber).toBe(3);
		});

		it('should handle real-world B-frame pattern', () => {
			// H.264 GOP with B-frames: I B B P
			const packets = [
				new EncodedPacket(new Uint8Array([0]), 'key', 0.0, 0.0167, 721),
				new EncodedPacket(new Uint8Array([1]), 'delta', 0.0167, 0.0167, 723),
				new EncodedPacket(new Uint8Array([2]), 'delta', 0.0333, 0.0167, 724),
				new EncodedPacket(new Uint8Array([3]), 'delta', 0.05, 0.0167, 722),
			];

			const sorted = [...packets].sort((a, b) => a.sequenceNumber - b.sequenceNumber);

			// Decode order: I -> P -> B -> B
			expect(sorted[0]!.sequenceNumber).toBe(721);
			expect(sorted[1]!.sequenceNumber).toBe(722);
			expect(sorted[2]!.sequenceNumber).toBe(723);
			expect(sorted[3]!.sequenceNumber).toBe(724);

			const displayOrder = [...packets].sort((a, b) => a.timestamp - b.timestamp);
			expect(displayOrder[0]!.timestamp).toBe(0.0);
			expect(displayOrder[1]!.timestamp).toBeCloseTo(0.0167, 4);
			expect(displayOrder[2]!.timestamp).toBeCloseTo(0.0333, 4);
			expect(displayOrder[3]!.timestamp).toBeCloseTo(0.05, 4);
		});
	});

	describe('Timestamp-based packet lookup', () => {
		it('should find packet by timestamp with epsilon comparison', () => {
			const packets = [
				new EncodedPacket(new Uint8Array([1]), 'key', 0.0, 0.033, 0),
				new EncodedPacket(new Uint8Array([2]), 'delta', 0.033333, 0.033, 1),
				new EncodedPacket(new Uint8Array([3]), 'delta', 0.066666, 0.033, 2),
			];

			const targetTimestamp = 0.033333;
			const epsilon = 0.0001;

			const foundIndex = packets.findIndex(
				p => Math.abs(p.timestamp - targetTimestamp) < epsilon,
			);

			expect(foundIndex).toBe(1);
			expect(packets[foundIndex]!.sequenceNumber).toBe(1);
		});

		it('should handle floating point precision issues', () => {
			const packets = [
				new EncodedPacket(new Uint8Array([1]), 'key', 0.0, 0.1, 0),
				new EncodedPacket(new Uint8Array([2]), 'delta', 0.1, 0.1, 1),
				new EncodedPacket(new Uint8Array([3]), 'delta', 0.2, 0.1, 2),
				new EncodedPacket(new Uint8Array([4]), 'delta', 0.30000000000000004, 0.1, 3),
			];

			const targetTimestamp = 0.3;
			const epsilon = 0.0001;

			const foundIndex = packets.findIndex(
				p => Math.abs(p.timestamp - targetTimestamp) < epsilon,
			);

			expect(foundIndex).toBe(3);
		});

		it('should find next packet after current by timestamp', () => {
			const packets = [
				new EncodedPacket(new Uint8Array([1]), 'key', 0.0, 0.033, 0),
				new EncodedPacket(new Uint8Array([2]), 'delta', 0.033, 0.033, 1),
				new EncodedPacket(new Uint8Array([3]), 'delta', 0.066, 0.033, 2),
			];

			const currentPacket = packets[1]!;
			const epsilon = 0.0001;

			const currentIndex = packets.findIndex(
				p => Math.abs(p.timestamp - currentPacket.timestamp) < epsilon,
			);

			expect(currentIndex).toBe(1);

			const nextPacket = currentIndex < packets.length - 1 ? packets[currentIndex + 1] : null;
			expect(nextPacket).not.toBeNull();
			expect(nextPacket!.sequenceNumber).toBe(2);
			expect(nextPacket!.timestamp).toBeCloseTo(0.066, 5);
		});
	});

	describe('Integration tests', () => {
		it('should correctly process a segment with B-frames and timestamp offset', () => {
			const fmp4BaseTime = 12.0;
			const playlistStartTime = 6.0;

			const rawPackets = [
				new EncodedPacket(new Uint8Array([0]), 'key', fmp4BaseTime + 0.0, 0.0167, 0),
				new EncodedPacket(new Uint8Array([1]), 'delta', fmp4BaseTime + 0.05, 0.0167, 1),
				new EncodedPacket(new Uint8Array([2]), 'delta', fmp4BaseTime + 0.0167, 0.0167, 2),
				new EncodedPacket(new Uint8Array([3]), 'delta', fmp4BaseTime + 0.0333, 0.0167, 3),
			];

			// Remap timestamps
			const timestampOffset = rawPackets[0]!.timestamp - playlistStartTime;
			const remappedPackets = rawPackets.map(p =>
				p.clone({ timestamp: p.timestamp - timestampOffset }),
			);

			expect(remappedPackets[0]!.timestamp).toBeCloseTo(6.0, 5);
			expect(remappedPackets[1]!.timestamp).toBeCloseTo(6.05, 5);
			expect(remappedPackets[2]!.timestamp).toBeCloseTo(6.0167, 4);
			expect(remappedPackets[3]!.timestamp).toBeCloseTo(6.0333, 4);

			// Sort by DTS
			const sortedPackets = [...remappedPackets].sort(
				(a, b) => a.sequenceNumber - b.sequenceNumber,
			);

			expect(sortedPackets[0]!.sequenceNumber).toBe(0);
			expect(sortedPackets[1]!.sequenceNumber).toBe(1);
			expect(sortedPackets[2]!.sequenceNumber).toBe(2);
			expect(sortedPackets[3]!.sequenceNumber).toBe(3);

			// Find by timestamp
			const epsilon = 0.0001;
			const targetTimestamp = 6.0167;
			const foundPacket = sortedPackets.find(
				p => Math.abs(p.timestamp - targetTimestamp) < epsilon,
			);

			expect(foundPacket).not.toBeUndefined();
			expect(foundPacket!.sequenceNumber).toBe(2);
		});

		it('should handle multiple segments with different timestamp offsets', () => {
			// Segment 1: playlist start 0s, fMP4 baseTime 0s
			const segment1Packets = [
				new EncodedPacket(new Uint8Array([1]), 'key', 0.0, 0.033, 0),
				new EncodedPacket(new Uint8Array([2]), 'delta', 0.033, 0.033, 1),
			];

			// Segment 2: playlist start 6s, fMP4 baseTime 10s
			const segment2RawPackets = [
				new EncodedPacket(new Uint8Array([3]), 'key', 10.0, 0.033, 0),
				new EncodedPacket(new Uint8Array([4]), 'delta', 10.033, 0.033, 1),
			];

			const segment2PlaylistStart = 6.0;
			const segment2Offset = segment2RawPackets[0]!.timestamp - segment2PlaylistStart;
			const segment2Packets = segment2RawPackets.map(p =>
				p.clone({ timestamp: p.timestamp - segment2Offset }),
			);

			expect(segment1Packets[0]!.timestamp).toBe(0.0);
			expect(segment1Packets[1]!.timestamp).toBe(0.033);

			expect(segment2Packets[0]!.timestamp).toBe(6.0);
			expect(segment2Packets[1]!.timestamp).toBeCloseTo(6.033, 5);

			const allPackets = [...segment1Packets, ...segment2Packets];
			const timestamps = allPackets.map(p => p.timestamp);

			expect(timestamps[0]).toBe(0.0);
			expect(timestamps[1]).toBe(0.033);
			expect(timestamps[2]).toBe(6.0);
			expect(timestamps[3]).toBeCloseTo(6.033, 5);
		});
	});

	describe('EncodedPacket.clone()', () => {
		it('should create a new packet with updated timestamp', () => {
			const original = new EncodedPacket(
				new Uint8Array([1, 2, 3]),
				'key',
				10.0,
				0.033,
				100,
			);

			const cloned = original.clone({ timestamp: 0.0 });

			expect(cloned.timestamp).toBe(0.0);
			expect(cloned.type).toBe('key');
			expect(cloned.duration).toBe(0.033);
			expect(cloned.sequenceNumber).toBe(100);
			expect(cloned.data).toBe(original.data);
		});

		it('should preserve original packet when cloning', () => {
			const original = new EncodedPacket(
				new Uint8Array([1, 2, 3]),
				'delta',
				5.0,
				0.05,
				50,
			);

			const cloned = original.clone({ timestamp: 1.0, duration: 0.1 });

			expect(original.timestamp).toBe(5.0);
			expect(original.duration).toBe(0.05);
			expect(cloned.timestamp).toBe(1.0);
			expect(cloned.duration).toBe(0.1);
		});

		it('should clone without options', () => {
			const original = new EncodedPacket(
				new Uint8Array([1]),
				'key',
				1.0,
				0.033,
				10,
			);

			const cloned = original.clone();

			expect(cloned.timestamp).toBe(original.timestamp);
			expect(cloned.duration).toBe(original.duration);
			expect(cloned.sequenceNumber).toBe(original.sequenceNumber);
		});
	});
});
