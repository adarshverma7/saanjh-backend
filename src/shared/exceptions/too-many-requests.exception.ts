import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 429 Too Many Requests exception.
 * NestJS 11 does not export TooManyRequestsException — this fills that gap.
 */
export class TooManyRequestsException extends HttpException {
  constructor(
    errorOrMessage:
      | string
      | { error: string; message: string } = 'Too Many Requests',
  ) {
    super(errorOrMessage, HttpStatus.TOO_MANY_REQUESTS);
  }
}
