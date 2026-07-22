import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Injects the authenticated user (request.user, a RequestUser).
 *   @CurrentUser()        → the whole RequestUser object
 *   @CurrentUser('sub')   → a single field (e.g. the user id via `sub`)
 *
 * Previously the field argument was ignored and the whole object was always
 * returned, so `@CurrentUser('sub')` silently passed the entire user object
 * where a UUID string was expected — breaking every controller that used it.
 */
export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const user = ctx.switchToHttp().getRequest().user;
    return data ? user?.[data] : user;
  },
);
