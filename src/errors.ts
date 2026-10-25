/**
 * The reason of a {@link PromptuariumError}.
 *
 * - `ABOVE_ROOT`: the stream navigates above the root (an Up chunk at the root level).
 * - `UNEXPECTED_END`: the stream ends inside a payload.
 * - `LIMIT_EXCEEDED`: the stream exceeds a limit of the {@link DecodeOptions}.
 * - `INVALID_OPERATION`: a tree operation would break the tree (e.g. a cycle), or the arguments contradict each other.
 */
export type PromptuariumErrorCode = 'ABOVE_ROOT' | 'UNEXPECTED_END' | 'LIMIT_EXCEEDED' | 'INVALID_OPERATION';

/**
 * An invalid stream, an exceeded limit or an invalid tree operation.
 */
export class PromptuariumError extends Error {
  /** The reason of the error. */
  readonly code: PromptuariumErrorCode;

  constructor(code: PromptuariumErrorCode, message: string) {
    super(message);
    this.name = 'PromptuariumError';
    this.code = code;
  }
}
