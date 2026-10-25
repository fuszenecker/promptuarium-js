// Constants and helpers of the binary format, see BINARY_FORMAT.md in the Promptuarium repository.

/** Bits 7-6 of the control byte: the direction. */
export const DirectionMask = 0xc0;
export const Append = 0x00;
export const Down = 0x40;
export const Up = 0x80;
export const New = 0xc0;

/** Bit 5 of the control byte: the content type. */
export const MetaData = 0x20;

/** Bit 4 of the control byte: the size type. */
export const Logarithmic = 0x10;

/** Bits 3-0 of the control byte: the size nibble. */
export const NibbleMask = 0x0f;

/** The largest payload of a chunk (logarithmic, nibble 15): 512 KiB. */
export const MaxChunkLength = 1 << 19;

/** The terminator: an Append chunk with length 0. */
export const Terminator = 0x00;

/** The length of the payload of a chunk. */
export function chunkLength(control: number): number {
  const nibble = control & NibbleMask;
  return (control & Logarithmic) !== 0 ? 1 << (nibble + 4) : nibble;
}

/**
 * Splits a content of `length` bytes into chunks (BINARY_FORMAT.md, 6.2):
 * full 512 KiB chunks, then the remainder in binary, then the low 4 bits as a linear chunk.
 * Yields the size type and nibble of the control byte, and the length of the payload.
 */
export function* split(length: number): Generator<{ sizeBits: number; length: number }> {
  let remaining = length;

  while (remaining > 0) {
    if (remaining > MaxChunkLength) {
      yield { sizeBits: Logarithmic | 15, length: MaxChunkLength };
      remaining -= MaxChunkLength;
    } else if (remaining > NibbleMask) {
      // The highest set bit, between 4 and 19
      const bit = 31 - Math.clz32(remaining);
      yield { sizeBits: Logarithmic | (bit - 4), length: 1 << bit };
      remaining -= 1 << bit;
    } else {
      yield { sizeBits: remaining, length: remaining };
      remaining = 0;
    }
  }
}
