import { ExecutionContext } from '@nestjs/common';
import { CurrentUser } from './current-user.decorator';

// Pulls the underlying factory out of the param decorator so we can call it
// directly with (data, ctx). Standard NestJS param-decorator testing pattern.
function getFactory(decorator: () => ParameterDecorator) {
  class Probe {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    handler(@decorator() _v: unknown): void {}
  }
  const args = Reflect.getMetadata('__routeArguments__', Probe, 'handler');
  return args[Object.keys(args)[0]].factory as (
    data: string | undefined,
    ctx: ExecutionContext,
  ) => unknown;
}

describe('CurrentUser decorator', () => {
  const user = { id: 'user-1', sub: 'user-1', phone: '+910000000000' };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;

  const factory = getFactory(CurrentUser);

  it('returns the whole user object when no field is requested', () => {
    expect(factory(undefined, ctx)).toBe(user);
  });

  it('returns the user id string when asked for the "sub" field (regression)', () => {
    // Previously this returned the entire object, which then blew up as a UUID
    // param in every controller using @CurrentUser('sub').
    expect(factory('sub', ctx)).toBe('user-1');
    expect(typeof factory('sub', ctx)).toBe('string');
  });

  it('is safe when request.user is absent', () => {
    const emptyCtx = {
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext;
    expect(factory('sub', emptyCtx)).toBeUndefined();
  });
});
